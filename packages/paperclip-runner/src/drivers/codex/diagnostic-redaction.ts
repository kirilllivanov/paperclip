/** Redact diagnostic text without importing the provider process or its credentials. */
export function redactCodexDiagnostic(message: string, secrets: readonly string[] = []): string {
  for (const value of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(value, "[REDACTED]").replaceAll(JSON.stringify(value).slice(1, -1), "[REDACTED]");
  }
  return message
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+([A-Za-z0-9+/=]+)/gi, (match, encoded: string) => {
      try {
        // Only redact an actual RFC 7617 credential. Ordinary prose such as
        // “Basic API” must remain readable.
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        return decoded.includes(":") ? "Basic [REDACTED]" : match;
      } catch {
        return match;
      }
    })
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["'](?:api[_-]?key|token|secret|password|authorization)["']\s*:\s*["'])[^"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /(PAPERCLIP_CODEX_HEADER_SECRET_\d+)=[^\s]+/g,
      "$1=[REDACTED]",
    )
    .replace(
      /((?:[A-Z][A-Z0-9]*_)+API_KEY)=[^\s]+/g,
      "$1=[REDACTED]",
    );
}

export function redactCodexDiagnosticValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 32) return "[REDACTED: diagnostic depth limit]";
  if (typeof value === "string") return redactCodexDiagnostic(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactCodexDiagnosticValue(item, secrets, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactCodexDiagnosticValue(item, secrets, depth + 1)]),
  );
  return value;
}

/** Redact diagnostic content without changing the identities used to route a notification. */
export function redactCodexNotificationParams(
  method: string,
  params: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  if (["error", "warning", "configWarning"].includes(method)) return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key,
      ["threadId", "turnId", "itemId"].includes(key) ? value : redactCodexDiagnosticValue(value, secrets),
    ]),
  );
  if (method === "turn/completed" && params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)) {
    const turn = params.turn as Record<string, unknown>;
    if (turn.error !== undefined) return { ...params, turn: { ...turn, error: redactCodexDiagnosticValue(turn.error, secrets) } };
  }
  return params;
}
