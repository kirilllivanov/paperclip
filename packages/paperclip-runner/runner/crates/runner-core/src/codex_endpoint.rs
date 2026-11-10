//! Managed Codex credentials cross the provider boundary, never the task shell boundary.
use serde_json::Value;

pub(crate) const HEADER_ENV_KEYS: &[&str] = &[
    "PAPERCLIP_CODEX_HEADER_SECRET_0",
    "PAPERCLIP_CODEX_HEADER_SECRET_1",
    "PAPERCLIP_CODEX_HEADER_SECRET_2",
    "PAPERCLIP_CODEX_HEADER_SECRET_3",
    "PAPERCLIP_CODEX_HEADER_SECRET_4",
    "PAPERCLIP_CODEX_HEADER_SECRET_5",
    "PAPERCLIP_CODEX_HEADER_SECRET_6",
    "PAPERCLIP_CODEX_HEADER_SECRET_7",
    "PAPERCLIP_CODEX_HEADER_SECRET_8",
    "PAPERCLIP_CODEX_HEADER_SECRET_9",
    "PAPERCLIP_CODEX_HEADER_SECRET_10",
    "PAPERCLIP_CODEX_HEADER_SECRET_11",
    "PAPERCLIP_CODEX_HEADER_SECRET_12",
    "PAPERCLIP_CODEX_HEADER_SECRET_13",
    "PAPERCLIP_CODEX_HEADER_SECRET_14",
    "PAPERCLIP_CODEX_HEADER_SECRET_15",
];

pub(crate) fn diagnostic_secrets(lookup: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let mut secrets = Vec::new();
    for key in std::iter::once("PAPERCLIP_AI_PROVIDER_KEY").chain(HEADER_ENV_KEYS.iter().copied()) {
        if let Some(value) = lookup(key).filter(|value| !value.is_empty()) {
            let encoded = serde_json::to_string(&value).expect("string is serializable");
            secrets.push(encoded[1..encoded.len() - 1].to_owned());
            secrets.push(value);
        }
    }
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    secrets.dedup();
    secrets
}

pub(crate) fn redact_text(input: &str, secrets: &[String]) -> String {
    let mut result = input.to_owned();
    for secret in secrets {
        result = result.replace(secret, "[REDACTED]");
    }
    result
}

fn redact_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => *text = redact_text(text, secrets),
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| redact_value(value, secrets)),
        Value::Object(object) => object
            .values_mut()
            .for_each(|value| redact_value(value, secrets)),
        _ => {}
    }
}

/// Keep routing identities and tool requests intact; redact diagnostic content before retention.
pub(crate) fn redact_message(message: &mut Value, secrets: &[String]) {
    let Some(method) = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        if let Some(error) = message.get_mut("error") {
            redact_value(error, secrets);
        }
        return;
    };
    if message.get("id").is_some() {
        return;
    }
    let Some(params) = message.get_mut("params") else {
        return;
    };
    if matches!(method.as_str(), "error" | "warning" | "configWarning") {
        if let Some(object) = params.as_object_mut() {
            for (key, value) in object {
                if !matches!(key.as_str(), "threadId" | "turnId" | "itemId") {
                    redact_value(value, secrets);
                }
            }
        }
    } else if method == "turn/completed" {
        if let Some(error) = params
            .get_mut("turn")
            .and_then(|turn| turn.get_mut("error"))
        {
            redact_value(error, secrets);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_selected_credentials_and_json_escaped_values_longest_first() {
        let secrets = diagnostic_secrets(|key| match key {
            "PAPERCLIP_AI_PROVIDER_KEY" => Some("fixture-bearer".into()),
            "PAPERCLIP_CODEX_HEADER_SECRET_0" => Some("fixture-bearer-longer\"header".into()),
            _ => None,
        });
        assert_eq!(
            redact_text(
                "rejected fixture-bearer-longer\"header fixture-bearer",
                &secrets
            ),
            "rejected [REDACTED] [REDACTED]"
        );
        assert_eq!(
            redact_text(r#"rejected fixture-bearer-longer\"header"#, &secrets),
            "rejected [REDACTED]"
        );
    }

    #[test]
    fn redacts_rpc_errors_and_notifications_without_changing_protocol_identities() {
        let secrets = vec!["1".to_owned()];
        for method in ["error", "warning", "configWarning"] {
            let mut message = json!({"method": method, "params": {"threadId":"thread-1", "turnId":"turn-1", "message":"rejected 1", "details":{"upstream":"rejected 1"}}});
            redact_message(&mut message, &secrets);
            assert_eq!(message["params"]["threadId"], "thread-1");
            assert_eq!(message["params"]["turnId"], "turn-1");
            assert_eq!(message["params"]["message"], "rejected [REDACTED]");
            assert_eq!(
                message["params"]["details"]["upstream"],
                "rejected [REDACTED]"
            );
        }
        let mut rpc = json!({"id":1,"error":{"code":401,"message":"rejected 1"}});
        redact_message(&mut rpc, &secrets);
        assert_eq!(rpc["error"]["message"], "rejected [REDACTED]");
        assert_eq!(rpc["id"], 1);
        assert_eq!(rpc["error"]["code"], 401);
        let mut terminal = json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed","error":{"message":"rejected 1"}}}});
        redact_message(&mut terminal, &secrets);
        assert_eq!(terminal["params"]["turn"]["id"], "turn-1");
        assert_eq!(
            terminal["params"]["turn"]["error"]["message"],
            "rejected [REDACTED]"
        );
        let mut request =
            json!({"id":1,"method":"item/tool/call","params":{"arguments":{"amount":"1"}}});
        let original = request.clone();
        redact_message(&mut request, &secrets);
        assert_eq!(request, original);
    }
}
