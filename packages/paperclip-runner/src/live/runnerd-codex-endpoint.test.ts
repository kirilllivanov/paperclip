import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { expect, it } from "vitest";
import { CODEX_HEADER_ENV_KEYS } from "../drivers/codex-endpoint.js";
import { resolvePinnedCodexCommand } from "../drivers/codex/codex-command.js";
import { configuredEnvironmentProjection } from "../configured-environment.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

it("delivers selected endpoint headers through runnerd to real Codex and redacts rejected credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-runnerd-endpoint-"));
  const received = Promise.withResolvers<{ path: string; headers: IncomingHttpHeaders }>();
  const bearer = "fixture-private-bearer";
  const headerValues = CODEX_HEADER_ENV_KEYS.map((_, i) => `fixture-private-header-${i}`);
  const upstreamError = `upstream rejected ${bearer} ${headerValues.join(" ")}`;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") received.resolve({ path: req.url!, headers: req.headers });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: upstreamError, type: "authentication_error" } }));
    });
  });
  const diagnostics: string[] = [];
  const failures: unknown[] = [];
  let transport: ReturnType<typeof createCapabilityRunnerdCodexTransport>["transport"] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/backend-api/codex`;
    const source = join(root, "source"), workspace = join(root, "workspace");
    await mkdir(source);
    await mkdir(workspace);
    await writeFile(join(source, "config.toml"), stringify({ model_provider: "paperclip",
      web_search: "live", service_tier: "default", features: { standalone_web_search: true },
      model_providers: { paperclip: { name: "openai", base_url: baseUrl, wire_api: "responses", requires_openai_auth: false,
        supports_websockets: true, supports_standalone_web_search: true,
        env_key: "PAPERCLIP_AI_PROVIDER_KEY", env_http_headers: Object.fromEntries(CODEX_HEADER_ENV_KEYS.map((key, i) => [`X-Fixture-${i}`, key])) } },
    }));
    const selected = { PATH: process.env.PATH, HOME: root, CODEX_HOME: source, PAPERCLIP_AI_PROVIDER_KEY: bearer,
      ...Object.fromEntries(CODEX_HEADER_ENV_KEYS.map((key, i) => [key, headerValues[i]])) };
    // The disposable test container supplies the sandbox; nested bwrap namespaces are unavailable.
    transport = createCapabilityRunnerdCodexTransport({ provider: "codex", externallySandboxed: true, stateDirectory: join(root, "runner"),
      ...(process.env.PAPERCLIP_TEST_RUNNER_BINARY ? { runnerBinary: process.env.PAPERCLIP_TEST_RUNNER_BINARY } : {}),
      codexCommand: resolvePinnedCodexCommand(), sourceCodexHome: source,
      environment: { ...selected, ...configuredEnvironmentProjection(selected) },
      onDiagnostic: message => diagnostics.push(message),
    }).transport;
    await transport.request("initialize", { clientInfo: { name: "paperclip-endpoint-test", version: "1" }, capabilities: { experimentalApi: true } });
    transport.notify("initialized");
    const started = await transport.request("thread/start", { model: "gpt-5.4", cwd: workspace, approvalPolicy: "never", sandbox: "read-only" });
    const thread = started.thread as { id: string };
    await transport.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Reply OK." }] });
    const result = await Promise.race([
      (async () => {
        const outgoing = await received.promise;
        expect(outgoing.path).toBe("/backend-api/codex/responses");
        expect(outgoing.headers.authorization).toBe(`Bearer ${bearer}`);
        for (let i = 0; i < headerValues.length; i++) expect(outgoing.headers[`x-fixture-${i}`]).toBe(headerValues[i]);
        const notifications = [];
        for await (const notification of transport!.notifications()) {
          notifications.push(notification);
          if (notification.method === "turn/completed") return notifications;
        }
        throw new Error("Runner stopped before reporting the rejected turn");
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Runner did not complete the endpoint fixture")), 30_000); }),
    ]);
    const retained = JSON.stringify({ diagnostics, notifications: result });
    expect(retained).toContain("upstream rejected");
    for (const secret of [bearer, ...headerValues]) expect(retained).not.toContain(secret);
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    try { await transport?.close(); } catch (error) { failures.push(error); }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, `Endpoint fixture failed: ${diagnostics.join("\n")}`);
}, 60_000);
