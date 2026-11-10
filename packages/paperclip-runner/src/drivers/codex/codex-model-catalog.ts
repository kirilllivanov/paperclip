import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareIsolatedCodexHome } from "../runtime-context-materializer.js";
import { CODEX_HEADER_ENV_KEYS } from "../codex-endpoint.js";
import { createSanitizedCodexEnvironment, ProcessCodexAppServerTransport, type CodexAppServerTransport } from "./app-server-transport.js";
import { resolvePinnedCodexCommand } from "./codex-command.js";
import { createIsolatedCodexAppServerArgs } from "./codex-security-config.js";
import { redactCodexDiagnostic } from "./diagnostic-redaction.js";

/** Read the native catalog; app-server owns HTTP, provider auth and model metadata. */
export async function readCodexModelCatalog(transport: Pick<CodexAppServerTransport, "request">) {
  const models = new Map<string, { id: string; label: string }>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await transport.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error("Codex returned an invalid model catalog");
    for (const item of result.data) {
      if (!item || typeof item !== "object") continue;
      const model = item as Record<string, unknown>;
      const id = typeof model.model === "string" ? model.model : model.id;
      if (typeof id !== "string" || !id || id.length > 256 || model.hidden === true) continue;
      models.set(id, { id, label: typeof model.displayName === "string" ? model.displayName : id });
    }
    if (!result.nextCursor) return [...models.values()];
    if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Codex returned an invalid model catalog cursor");
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error("Codex model catalog exceeded the page limit");
}

/** A bounded metadata-only probe. No thread, turn, MCP tool or inference is started. */
export async function probeCodexModelCatalog(input: {
  sourceCodexHome: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-codex-models-"));
  let transport: ProcessCodexAppServerTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await prepareIsolatedCodexHome({ context: null, codexHome: home, sourceCodexHome: input.sourceCodexHome });
    const environment = createSanitizedCodexEnvironment({ ...input.environment, HOME: home, CODEX_HOME: home });
    transport = new ProcessCodexAppServerTransport({
      command: input.command ?? resolvePinnedCodexCommand(),
      args: createIsolatedCodexAppServerArgs(environment),
      workingDirectory: workspace, environment, processGroup: true,
    });
    const active = transport;
    return await Promise.race([
      (async () => {
        await active.request("initialize", { clientInfo: { name: "paperclip-runner", version: "codex-models" }, capabilities: { experimentalApi: true } });
        active.notify("initialized");
        const models = await readCodexModelCatalog(active);
        if (!models.length) throw new Error("Codex returned no models. Check the endpoint's native /models catalog and authentication, or specify model IDs in the connection.");
        return models;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex model discovery timed out")), input.timeoutMs ?? 20_000); }),
    ]);
  } catch (error) {
    const secrets = [input.environment.PAPERCLIP_AI_PROVIDER_KEY, ...CODEX_HEADER_ENV_KEYS.map(key => input.environment[key])].filter((v): v is string => Boolean(v));
    throw new Error(redactCodexDiagnostic(error instanceof Error ? error.message : "Codex model discovery failed", secrets));
  } finally {
    clearTimeout(timer);
    try { await transport?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
