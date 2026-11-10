import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { stringify } from "smol-toml";
import { readCodexModelCatalog, probeCodexModelCatalog } from "./codex-model-catalog.js";
import { resolvePinnedCodexCommand } from "./codex-command.js";

describe("Codex model catalog", () => {
  it("uses the app-server model identifiers, follows cursors and excludes hidden models", async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [{ id: "display-id", model: "endpoint-model", displayName: "Endpoint model" }, { id: "hidden", hidden: true }], nextCursor: "page-2" })
      .mockResolvedValueOnce({ data: [{ id: "second" }, { id: "display-id", model: "endpoint-model", displayName: "Updated label" }], nextCursor: null });
    expect(await readCodexModelCatalog({ request })).toEqual([{ id: "endpoint-model", label: "Updated label" }, { id: "second", label: "second" }]);
    expect(request).toHaveBeenNthCalledWith(2, "model/list", { limit: 100, includeHidden: false, cursor: "page-2" });
  });
  it("rejects repeated cursors rather than repeatedly requesting the catalog", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], nextCursor: "same" });
    await expect(readCodexModelCatalog({ request })).rejects.toThrow("cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reports app-server errors without substituting a static catalog", async () => {
    await expect(readCodexModelCatalog({ request: vi.fn().mockRejectedValue(new Error("fixture unavailable")) })).rejects.toThrow("fixture unavailable");
  });

  it("uses the real app-server catalog and provider credentials without starting an inference turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-codex-catalog-fixture-"));
    const command = process.env.PAPERCLIP_TEST_CODEX_COMMAND ?? resolvePinnedCodexCommand();
    const requests: { method: string; path: string; bearer: unknown; header: unknown }[] = [];
    // Match the installed native catalog schema without duplicating provider defaults.
    const bundled = JSON.parse(execFileSync(command, ["debug", "models", "--bundled"], {
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }));
    const fixture = { ...(Array.isArray(bundled) ? bundled : bundled.models)[0], slug: "paperclip-fixture-model", display_name: "Fixture model", visibility: "list", supported_in_api: true, base_instructions: "Fixture" };
    let hang = false;
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      requests.push({ method: request.method!, path: request.url!, bearer: request.headers.authorization, header: request.headers["x-fixture"] });
      if (hang) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [fixture] }));
    });
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/backend-api/codex`;
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "config.toml"), stringify({ model_provider: "paperclip", openai_base_url: baseUrl,
        web_search: "live", service_tier: "default", features: { standalone_web_search: true },
        model_providers: { paperclip: { name: "openai", base_url: baseUrl, model_catalog_url: `${baseUrl}/models`, wire_api: "responses", requires_openai_auth: false,
          supports_websockets: true, supports_standalone_web_search: true, env_key: "PAPERCLIP_AI_PROVIDER_KEY", env_http_headers: { "X-Fixture": "PAPERCLIP_CODEX_HEADER_SECRET_0" } } } }));
      const input = { sourceCodexHome: source, command, environment: { PATH: process.env.PATH, PAPERCLIP_AI_PROVIDER_KEY: "fixture-token", PAPERCLIP_CODEX_HEADER_SECRET_0: "fixture-header" } };
      const catalog = await probeCodexModelCatalog(input);
      expect(requests.length).toBeGreaterThan(0);
      expect(catalog).toEqual([{ id: "paperclip-fixture-model", label: "Fixture model" }]);
      for (const request of requests) expect(request).toMatchObject({ method: "GET", bearer: "Bearer fixture-token", header: "fixture-header", path: expect.stringMatching(/^\/backend-api\/codex\/models\?client_version=/) });
      hang = true;
      await expect(probeCodexModelCatalog({ ...input, timeoutMs: 1000 })).rejects.toThrow("timed out");
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
