import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareIsolatedCodexHome } from "./runtime-context-materializer.js";
import { createSanitizedCodexEnvironment, ProcessCodexAppServerTransport } from "./codex/app-server-transport.js";
import { resolvePinnedCodexCommand } from "./codex/codex-command.js";
import { createIsolatedCodexAppServerArgs } from "./codex/codex-security-config.js";
import { configuredEnvironmentProjection } from "../configured-environment.js";
import { parse, stringify } from "smol-toml";

function providerConfig(baseUrl: string, headers: string) {
  return `model_provider = "paperclip"
openai_base_url = ${JSON.stringify(baseUrl)}
web_search = "live"
service_tier = "default"
[features]
standalone_web_search = true
[model_providers.paperclip]
name = "openai"
base_url = ${JSON.stringify(baseUrl)}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
supports_standalone_web_search = true
env_key = "PAPERCLIP_AI_PROVIDER_KEY"
env_http_headers = { ${headers} }
`;
}

describe("native Codex endpoint", () => {
  it("merges provider options with the controller MCP gateway and observability while excluding host tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-codex-merge-"));
    try {
      const source = join(root, "source"), home = join(root, "isolated");
      await mkdir(source);
      await writeFile(join(source, "config.toml"), stringify({
        ...parse(providerConfig("https://codex.example.com/backend-api/codex", "")),
        openai_base_url: "https://untrusted.example", web_search: "cached", service_tier: "default",
        features: { shell_snapshot: true, plugins: true, standalone_web_search: true, memories: true },
        mcp_servers: { openaiDeveloperDocs: { url: "https://developers.openai.com/mcp" }, hostTool: { command: "untrusted" } },
      }));
      await prepareIsolatedCodexHome({ context: null, sourceCodexHome: source, codexHome: home,
        observability: { kind: "codex", compatibilityKey: "fixture", environment: {}, otelConfig: { log_user_prompt: false } },
        nativeMcp: { name: "paperclip", url: "http://127.0.0.1:3100/mcp", token: "gateway-fixture" },
      });
      const config = parse(await readFile(join(home, "config.toml"), "utf8"));
      expect(config).toMatchObject({ openai_base_url: "https://codex.example.com/backend-api/codex", web_search: "cached", service_tier: "default",
        analytics: { enabled: false }, feedback: { enabled: false }, otel: { log_user_prompt: false },
        features: { shell_snapshot: false, api_key_model_discovery: true, standalone_web_search: true },
        model_providers: { paperclip: { name: "openai", requires_openai_auth: false, supports_websockets: true, model_catalog_url: "https://codex.example.com/backend-api/codex/models" } },
        mcp_servers: { paperclip: { default_tools_approval_mode: "approve", http_headers: { Authorization: "Bearer gateway-fixture" } } },
      });
      expect(config.features).not.toHaveProperty("memories");
      expect(config.features).not.toHaveProperty("plugins");
      expect(config.mcp_servers).not.toHaveProperty("openaiDeveloperDocs");
      expect(config.mcp_servers).not.toHaveProperty("hostTool");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    { scope: "provider", key: "requires_openai_auth", value: true, error: "provider configuration" },
    { scope: "provider", key: "supports_websockets", value: false, error: "WebSocket capability" },
    { scope: "provider", key: "supports_websockets", value: undefined, error: "WebSocket capability" },
    { scope: "provider", key: "supports_standalone_web_search", value: undefined, error: "capabilities" },
    { scope: "config", key: "web_search", value: undefined, error: "web search mode" },
    { scope: "config", key: "service_tier", value: undefined, error: "service tier" },
    { scope: "features", key: "standalone_web_search", value: undefined, error: "feature flag" },
  ])("rejects unsupported or missing endpoint settings: $scope.$key=$value", async ({ scope, key, value, error }) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-codex-settings-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      const config = parse(providerConfig("https://codex.example.com/backend-api/codex", ""));
      const section = scope === "provider" ? (config.model_providers as { paperclip: Record<string, unknown> }).paperclip
        : scope === "features" ? config.features as Record<string, unknown> : config;
      if (value === undefined) delete section[key];
      else section[key] = value;
      await writeFile(join(source, "config.toml"), stringify(config));
      await expect(prepareIsolatedCodexHome({ context: null, sourceCodexHome: source, codexHome: join(root, "isolated") }))
        .rejects.toThrow(error);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("sends a real pinned app-server request to the exact backend path with selected credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-codex-endpoint-"));
    const received = Promise.withResolvers<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }>();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "POST") received.resolve({ path: req.url!, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        // Deliberate auth rejection: this test proves transport, not a live model answer.
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":{"message":"fixture rejection","type":"authentication_error"}}');
      });
    });
    let transport: ProcessCodexAppServerTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const source = join(root, "source");
      const home = join(root, "isolated");
      const workspace = join(root, "workspace");
      await mkdir(source);
      await mkdir(workspace);
      await writeFile(join(source, "config.toml"), providerConfig(`http://127.0.0.1:${address.port}/backend-api/codex`, '"ChatGPT-Account-Id" = "PAPERCLIP_CODEX_HEADER_SECRET_0", "X-Custom" = "PAPERCLIP_CODEX_HEADER_SECRET_1"'));
      await prepareIsolatedCodexHome({ context: null, codexHome: home, sourceCodexHome: source });
      const environment = createSanitizedCodexEnvironment({
        PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
        PAPERCLIP_AI_PROVIDER_KEY: "fixture-bearer",
        PAPERCLIP_CODEX_HEADER_SECRET_0: "fixture-account", PAPERCLIP_CODEX_HEADER_SECRET_1: "fixture-header",
      });
      const config = await readFile(join(home, "config.toml"), "utf8");
      expect(config).not.toMatch(/fixture-bearer|fixture-account|fixture-header/);
      expect(config).toContain("shell_snapshot = false");
      const projection = configuredEnvironmentProjection(environment);
      expect(projection).not.toHaveProperty("PAPERCLIP_CODEX_HEADER_SECRET_0");
      const args = createIsolatedCodexAppServerArgs(environment);
      expect(args.join("\n")).not.toMatch(/PAPERCLIP_CODEX_HEADER|fixture-bearer|fixture-account|fixture-header/);
      transport = new ProcessCodexAppServerTransport({
        command: process.env.PAPERCLIP_TEST_CODEX_COMMAND ?? resolvePinnedCodexCommand(), args,
        workingDirectory: workspace, environment, processGroup: true,
      });
      await transport.request("initialize", { clientInfo: { name: "paperclip-endpoint-test", version: "1" }, capabilities: { experimentalApi: true } });
      transport.notify("initialized");
      const started = await transport.request("thread/start", { model: "gpt-5.4", cwd: workspace, approvalPolicy: "never", sandbox: "read-only" });
      const thread = started.thread as { id: string };
      await transport.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply OK." }] });
      const outgoing = await Promise.race([
        received.promise,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex did not reach the fixture endpoint")), 15_000); }),
      ]);
      expect(outgoing.path).toBe("/backend-api/codex/responses");
      expect(outgoing.headers).toMatchObject({ authorization: "Bearer fixture-bearer", "chatgpt-account-id": "fixture-account", "x-custom": "fixture-header" });
      expect(outgoing.body).toMatchObject({ model: "gpt-5.4", stream: true, store: false });
    } finally {
      clearTimeout(timer);
      await transport?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    '"Authorization" = "PAPERCLIP_CODEX_HEADER_SECRET_0"',
    '"X-Custom" = "DATABASE_URL"',
    '"X-Custom" = "PAPERCLIP_CODEX_HEADER_SECRET_16"',
    '"X-Custom" = "PAPERCLIP_CODEX_HEADER_SECRET_0", "x-custom" = "PAPERCLIP_CODEX_HEADER_SECRET_1"',
  ])("rejects untrusted header bindings: %s", async headers => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-codex-bindings-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "config.toml"), providerConfig("https://codex.example.com/backend-api/codex", headers));
      await expect(prepareIsolatedCodexHome({ context: null, codexHome: join(root, "isolated"), sourceCodexHome: source })).rejects.toThrow("header bindings");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
