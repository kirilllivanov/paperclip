import type { Db } from "@paperclipai/db";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { withManagedAiProbe } from "./ai-connection-runtime.js";
import { probeCodexModelCatalog } from "../vendor/paperclip-runner/index.js";
import { unprocessable } from "../errors.js";

/** Resolve permissions and credentials using the same path as an agent run. */
export function listCodexConnectionModels(db: Db, input: {
  companyId: string;
  agentId: string;
  responsibleUserId: string | null;
  binding: AiConnectionBinding;
  allowUninstalledShared: boolean;
}) {
  return withManagedAiProbe(db, {
    ...input, adapterType: "paperclip_runner", config: { provider: "codex" }, allowUninstalledPersonal: true,
  }, async runtime => {
    if ((runtime.config.managedAiRouting as { protocol?: string } | undefined)?.protocol !== "codex") {
      throw unprocessable("Select a custom Codex endpoint connection for model discovery");
    }
    const projected = runtime.config.env as Record<string, unknown>;
    const environment = { ...process.env, ...Object.fromEntries(Object.entries(projected).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
    if (!environment.CODEX_HOME) throw new Error("The selected Codex connection has no runtime home");
    return probeCodexModelCatalog({ sourceCodexHome: environment.CODEX_HOME, environment });
  });
}
