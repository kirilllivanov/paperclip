import { describe, it, expect } from "vitest";
import {
  aiProviderRoutingSchema,
  aiRoutingHarness,
  aiRoutingModel,
  createAiConnectionSchema,
  isAiConnectionCompatible,
  aiConnectionCatalogSlug,
  aiProviderSetupPreset,
  CODEX_HEADER_ENV_KEYS,
  isCodexHeaderName,
  isPrivateEndpointHost,
} from "@paperclipai/shared";
import * as runnerContract from "../../../packages/paperclip-runner/src/drivers/codex-endpoint.js";
import { managedProviderRouting } from "../services/ai-provider-routing.js";
import { parse } from "smol-toml";

describe("provider routing", () => {
  const codexRoute = { kind: "gateway", protocol: "codex", auth: "bearer", baseUrl: "http://192.168.1.10/backend-api/codex", models: [],
    codex: { webSearch: "live", serviceTier: "default", standaloneWebSearch: true } } as const;
  const codexInput = { provider: "openai", method: "api_key", name: "Codex backend", ownership: "personal", routing: { ...codexRoute, models: [] }, apiKey: "custom-bearer" } as const;
  it("keeps Runner and control-plane endpoint contracts in sync", () => {
    expect(runnerContract.CODEX_HEADER_ENV_KEYS).toEqual(CODEX_HEADER_ENV_KEYS);
    for (const name of ["ChatGPT-Account-Id", "X-Custom", "Authorization", "host", "bad\nname", "Content-Length"])
      expect(runnerContract.isCodexHeaderName(name)).toBe(isCodexHeaderName(name));
    for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "172.32.0.1", "192.168.1.1", "169.254.169.254", "8.8.8.8"])
      expect(runnerContract.isPrivateEndpointHost(host)).toBe(isPrivateEndpointHost(host));
  });
  it("accepts a private HTTP Codex backend only for native Runner Codex", () => {
    expect(aiConnectionCatalogSlug("openai", codexRoute)).toBe("codex-endpoint");
    expect(aiProviderSetupPreset("codex-endpoint")).toEqual({ provider: "codex", protocol: "codex", label: "Codex endpoint" });
    const input = createAiConnectionSchema.parse(codexInput);
    expect(isAiConnectionCompatible(input, "paperclip_runner", "gpt-5.4", "codex")).toBe(true);
    for (const [adapter, provider] of [["codex_local", undefined], ["paperclip_runner", "opencode"], ["paperclip_runner", "acpx"]])
      expect(isAiConnectionCompatible(input, adapter!, "model", provider)).toBe(false);
    for (const baseUrl of ["http://8.8.8.8/backend-api/codex", "http://169.254.169.254/", "http://user:secret@192.168.1.10", "http://192.168.1.10/?key=value"])
      expect(aiProviderRoutingSchema.safeParse({ ...codexRoute, baseUrl }).success).toBe(false);
    expect(aiProviderRoutingSchema.safeParse({ ...codexRoute, protocol: "responses" }).success).toBe(false);
    expect(aiProviderRoutingSchema.safeParse({ ...codexRoute, auth: "none" }).success).toBe(false);
  });
  it("projects token and header secrets without writing them into Codex config", () => {
    const routing = aiProviderRoutingSchema.parse(codexRoute);
    const result = managedProviderRouting(routing, "codex_local", JSON.stringify({
      bearerToken: "custom-bearer", httpHeaders: [{ name: "ChatGPT-Account-Id", value: "private-account" }, { name: "X-Custom", value: "private-header" }],
    }), "gpt-5.4");
    expect(result.env).toEqual({ PAPERCLIP_AI_PROVIDER_KEY: "custom-bearer", PAPERCLIP_CODEX_HEADER_SECRET_0: "private-account", PAPERCLIP_CODEX_HEADER_SECRET_1: "private-header" });
    expect(result.codexConfig).toContain('base_url = "http://192.168.1.10/backend-api/codex"');
    expect(parse(result.codexConfig)).toMatchObject({
      model_provider: "paperclip", openai_base_url: codexRoute.baseUrl,
      web_search: "live", service_tier: "default", analytics: { enabled: false }, feedback: { enabled: false },
      features: { api_key_model_discovery: true, standalone_web_search: true },
      model_providers: { paperclip: { name: "openai", requires_openai_auth: false,
        model_catalog_url: `${codexRoute.baseUrl}/models`, supports_websockets: true, supports_standalone_web_search: true,
        env_http_headers: { "ChatGPT-Account-Id": "PAPERCLIP_CODEX_HEADER_SECRET_0" } } },
    });
    expect(result.codexConfig).not.toMatch(/custom-bearer|private-account|private-header|\/v1/);
  });
  it("projects Codex search settings without adding native plugins or MCP servers", () => {
    const route = aiProviderRoutingSchema.parse({ ...codexRoute, codex: { webSearch: "disabled", serviceTier: "fast", standaloneWebSearch: false } });
    const config = parse(managedProviderRouting(route, "codex_local", JSON.stringify({ bearerToken: "fixture", httpHeaders: [] }), "").codexConfig);
    expect(config).toMatchObject({ web_search: "disabled", service_tier: "fast", features: { standalone_web_search: false }, model_providers: { paperclip: { requires_openai_auth: false, supports_websockets: true, supports_standalone_web_search: false } } });
    expect(config.features).not.toHaveProperty("plugins");
    expect(config).not.toHaveProperty("mcp_servers");
    expect(aiProviderRoutingSchema.safeParse({ ...codexRoute, protocol: "responses", baseUrl: "https://example.com/v1", codex: {} }).success).toBe(false);
  });
  it.each([undefined, {}, { webSearch: "live", serviceTier: "default" }])("rejects incomplete saved Codex settings: %j", codex => {
    expect(aiProviderRoutingSchema.safeParse({ ...codexRoute, codex }).success).toBe(false);
    expect(() => managedProviderRouting({ ...codexRoute, models: [], codex } as never, "codex_local",
      JSON.stringify({ bearerToken: "fixture", httpHeaders: [] }), "")).toThrow();
  });
  it("rejects duplicate, reserved and injected custom headers", () => {
    for (const httpHeaders of [
      [{ name: "Authorization", value: "Bearer override" }],
      [{ name: "X-Header", value: "first" }, { name: "x-header", value: "second" }],
      [{ name: "X-Header", value: "value\r\nInjected: yes" }],
      [{ name: "bad name", value: "value" }],
      [{ name: "X-Header", value: "nul\0value" }],
    ]) expect(createAiConnectionSchema.safeParse({ ...codexInput, httpHeaders }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...codexInput, routing: { ...codexRoute, baseUrl: "https://example.com/v1", protocol: "responses" }, httpHeaders: [{ name: "X-Header", value: "secret" }] }).success).toBe(false);
  });
  it("routes managed OpenRouter accounts to direct and native Pi without OpenCode configuration", () => {
    const routing = aiProviderRoutingSchema.parse({ kind: "openrouter", protocol: "chat" });
    expect(aiRoutingHarness("paperclip_runner", "acpx", "pi")).toBe("pi_local");
    for (const adapterType of ["pi_local", "paperclip_runner"]) {
      expect(isAiConnectionCompatible({ provider: "openrouter", method: "api_key", routing }, adapterType, "openrouter/anthropic/model", "acpx", "pi")).toBe(true);
    }
    expect(aiRoutingModel(routing, "pi_local", "anthropic/model")).toBe("openrouter/anthropic/model");
    expect(aiRoutingModel(routing, "pi_local", "openrouter/anthropic/model")).toBe("openrouter/anthropic/model");
    const projected = managedProviderRouting(routing, "pi_local", "selected-pi-key", "anthropic/model");
    expect(projected).toMatchObject({ config: { model: "openrouter/anthropic/model" }, env: { OPENROUTER_API_KEY: "selected-pi-key" } });
    expect(projected.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    expect(isAiConnectionCompatible({ provider: "openai", method: "api_key", routing: aiProviderRoutingSchema.parse({ kind: "gateway", protocol: "chat", baseUrl: "https://gateway.example/v1" }) }, "pi_local", "custom/model")).toBe(false);
  });
  it.each(["openai", "anthropic", "google", "openrouter"] as const)("accepts Pi %s API keys only for matching models", provider => {
    expect(isAiConnectionCompatible({ provider, method: "api_key" }, "paperclip_runner", `${provider}/model`, "acpx", "pi")).toBe(true);
    expect(isAiConnectionCompatible({ provider, method: "subscription" }, "pi_local", `${provider}/model`)).toBe(false);
    expect(isAiConnectionCompatible({ provider, method: "subscription", mode: "responsible_user" }, "pi_local", `${provider}/model`)).toBe(true);
    expect(isAiConnectionCompatible({ provider, method: "api_key" }, "pi_local", "different/model")).toBe(false);
  });
  it.each([
    "https://user:secret@gateway.example/v1",
    "https://gateway.example/v1?key=secret",
    "http://169.254.169.254/",
    "file:///tmp/secret",
    "https://gateway.example/#secret",
  ])("rejects unsafe or credential-bearing endpoint %s", (baseUrl) => {
    expect(
      aiProviderRoutingSchema.safeParse({
        kind: "gateway",
        protocol: "responses",
        baseUrl,
      }).success,
    ).toBe(false);
  });
  it("requires exactly the selected credential and disallows routed subscriptions", () => {
    const input = {
      provider: "openai",
      method: "api_key",
      name: "Local",
      ownership: "personal",
      routing: {
        kind: "local",
        protocol: "responses",
        auth: "none",
        baseUrl: "http://localhost:11434/v1",
      },
    };
    expect(createAiConnectionSchema.safeParse(input).success).toBe(true);
    expect(
      createAiConnectionSchema.safeParse({ ...input, apiKey: "unwanted" })
        .success,
    ).toBe(false);
    expect(
      createAiConnectionSchema.safeParse({
        ...input,
        method: "subscription",
        loginSessionId: "session",
      }).success,
    ).toBe(false);
  });
  it("rejects unsupported protocols and excluded remote adapters", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "gateway",
      protocol: "chat",
      baseUrl: "https://gateway.example/v1",
    });
    for (const adapter of [
      "codex_local",
      "claude_local",
      "http",
      "process",
      "openclaw_gateway",
      "hermes_gateway",
      "acpx_local",
    ])
      expect(
        isAiConnectionCompatible(
          { provider: "openai", method: "api_key", routing },
          adapter,
        ),
      ).toBe(false);
    expect(
      isAiConnectionCompatible(
        { provider: "openai", method: "api_key", routing },
        "opencode_local",
      ),
    ).toBe(true);
    expect(
      isAiConnectionCompatible(
        { provider: "openai", method: "api_key", routing },
        "paperclip_runner",
        "model",
        "aws_agentcore",
      ),
    ).toBe(false);
  });
  it.each(["gateway", "openrouter"] as const)("uses a terminal-filtered secret variable for Hermes %s authentication", kind => {
    const route = aiProviderRoutingSchema.parse({ kind, protocol: "chat", auth: "bearer", ...(kind === "gateway" ? { baseUrl: "https://gateway.example/v1" } : {}) });
    const projected = managedProviderRouting(route, "hermes_local", "selected-key", "fixture-model");
    expect(projected.env.OPENAI_API_KEY).toBe("selected-key");
    expect(projected.env.PAPERCLIP_AI_PROVIDER_KEY).toBeUndefined();
    expect(projected.hermesConfig).toContain('api_key: "${OPENAI_API_KEY}"');
    expect(projected.hermesConfig).not.toContain("selected-key");
    expect(Object.entries(projected.env).filter(([, value]) => value === "selected-key").map(([name]) => name)).toEqual(kind === "openrouter" ? ["OPENAI_API_KEY", "OPENROUTER_API_KEY"] : ["OPENAI_API_KEY"]);
  });
  it("routes OpenRouter through each harness's protocol without putting secrets in Codex config", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "openrouter",
      protocol: "responses",
    });
    const codex = managedProviderRouting(
      routing,
      "codex_local",
      "fixture-secret",
      "openai/gpt-5.4",
    );
    expect(codex.codexConfig).toContain('wire_api = "responses"');
    expect(codex.codexConfig).not.toContain("fixture-secret");
    const claude = managedProviderRouting(
      routing,
      "claude_local",
      "fixture-secret",
      "anthropic/claude-sonnet-4.6",
    );
    expect(claude.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-secret");
    expect(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    const opencode = managedProviderRouting(
      routing,
      "opencode_local",
      "fixture-secret",
      "anthropic/claude-sonnet-4.6",
    );
    expect(opencode.config.model).toBe(
      "openrouter/anthropic/claude-sonnet-4.6",
    );
  });
  it("projects only a Bedrock API key and rejects general AWS access keys", () => {
    const routing = aiProviderRoutingSchema.parse({
      kind: "bedrock",
      protocol: "bedrock",
      auth: "bearer",
      region: "us-east-1",
    });
    const projected = managedProviderRouting(
      routing,
      "claude_local",
      "fixture-bedrock-key",
      "bedrock-model",
    );
    expect(projected.env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "fixture-bedrock-key",
      AWS_EC2_METADATA_DISABLED: "true",
    });
    expect(aiProviderRoutingSchema.safeParse({ ...routing, auth: "aws_credentials" }).success).toBe(false);
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) expect(projected.env).not.toHaveProperty(key);
  });
});
