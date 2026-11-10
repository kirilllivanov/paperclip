import { isOpenRouterUrl, openRouterCodexHeaders } from "./openrouter-attribution.js";
import { randomUUID } from "node:crypto";
import { CODEX_HEADER_ENV_KEYS, isCodexHeaderName, isPrivateEndpointHost } from "./codex-endpoint.js";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type { NativeMcpLaunchBinding } from "./native-mcp.js";

async function assertSafeTree(root: string, child = ""): Promise<void> {
  const directory = child ? join(root, child) : root;
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink()) {
    throw new Error(
      `runtime context asset contains a symlink: ${child || "."}`,
    );
  }
  if (!directoryStat.isDirectory()) {
    throw new Error("runtime context asset root must be a directory");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = child ? `${child}/${entry.name}` : entry.name;
    const stat = await lstat(join(root, childRelative));
    if (stat.isSymbolicLink()) {
      throw new Error(
        `runtime context asset contains a symlink: ${childRelative}`,
      );
    }
    if (stat.isDirectory()) await assertSafeTree(root, childRelative);
    else if (!stat.isFile()) {
      throw new Error(
        `runtime context asset contains an unsupported file: ${childRelative}`,
      );
    }
  }
}

function safeMaterializationTarget(root: string, runtimeName: string): string {
  const segments = runtimeName.split("/");
  if (
    runtimeName.startsWith("/")
    || runtimeName.includes("\\")
    || runtimeName.includes("\0")
    || segments.some((segment) => /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment))
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => !segment.replace(/[ .]+$/u, ""))
    || segments.some(isWin32ReservedPathSegment)
  ) {
    throw new Error("runtime context skill name must be a safe relative path");
  }
  const target = resolve(root, runtimeName);
  const relation = relative(resolve(root), target);
  if (
    relation === ""
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new Error("runtime context skill name must stay inside the skills home");
  }
  return target;
}

function isWin32ReservedPathSegment(segment: string): boolean {
  const basename = segment
    .normalize("NFC")
    .split(".", 1)[0]!
    .replace(/[ .]+$/u, "")
    .toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(
    basename,
  );
}

function portableRuntimeNameKey(runtimeName: string): string {
  // Skill assignments must remain unambiguous when the same context is moved
  // between the case-sensitive Linux runner and the case-insensitive default
  // filesystems on macOS or Windows. NFC also catches composed/decomposed
  // aliases, while per-segment trimming matches Win32's treatment of trailing
  // dots and spaces before either spelling reaches the staging tree.
  return runtimeName
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, ""))
    .join("/")
    .toLowerCase();
}

async function protectStagedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("staged runtime context root must be a directory");
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await protectStagedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("staged runtime context asset must be a regular file");
        }
        await childHandle.chmod(openedChild.mode & 0o555);
      } finally {
        await childHandle.close();
      }
    }
    // Seal directories only after their descendants. Traversal needs execute
    // permission, but provider processes must not be able to rewrite assigned
    // skills after the immutable snapshot has been published.
    await rootHandle.chmod(0o555);
  } finally {
    await rootHandle.close();
  }
}

async function unprotectMaterializedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("materialized runtime context root must be a directory");
    }
    // Restore directory mutation before descending so every child can be
    // unlinked. Handles plus O_NOFOLLOW keep cleanup inside the sealed tree.
    await rootHandle.chmod(0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await unprotectMaterializedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("materialized runtime context asset must be a regular file");
        }
        await childHandle.chmod(0o600);
      } finally {
        await childHandle.close();
      }
    }
  } finally {
    await rootHandle.close();
  }
}

async function removeMaterializedTree(
  skillsHome: string,
  removeTree: (path: string) => Promise<void>,
): Promise<void> {
  const exists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists) return;
  await unprotectMaterializedTree(skillsHome);
  await removeTree(skillsHome);
}

/** Removes a previously sealed skills snapshot at an explicit lifecycle boundary. */
export async function releaseMaterializedNativeRuntimeSkills(
  skillsHome: string,
): Promise<void> {
  await removeMaterializedTree(
    skillsHome,
    (path) => rm(path, { recursive: true, force: true }),
  );
}

export async function materializeNativeRuntimeSkills(
  context: NativeRuntimeContextSnapshot | null,
  skillsHome: string,
  dependencies: {
    /** Internal test seam for failed staging cleanup coverage. */
    removeTree?: (path: string) => Promise<void>;
    /** Internal test seam for publication failure coverage. */
    renameTree?: (source: string, destination: string) => Promise<void>;
  } = {},
): Promise<void> {
  const removeTree =
    dependencies.removeTree ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const renameTree = dependencies.renameTree ?? rename;
  if (context) {
    const runtimeNames = new Set<string>();
    for (const skill of context.skills) {
      safeMaterializationTarget(skillsHome, skill.runtimeName);
      const runtimeName = portableRuntimeNameKey(skill.runtimeName);
      if (runtimeNames.has(runtimeName)) {
        throw new Error("runtime context skill names must not overlap");
      }
      runtimeNames.add(runtimeName);
    }
    for (const runtimeName of runtimeNames) {
      const segments = runtimeName.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        if (runtimeNames.has(segments.slice(0, length).join("/"))) {
          throw new Error("runtime context skill names must not overlap");
        }
      }
    }
    for (const skill of context.skills) {
      await assertSafeTree(skill.bundle.rootPath);
    }
  }

  const skillsHomeExists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (skillsHomeExists) {
    throw new Error(
      "runtime context skills home must be a fresh destination",
    );
  }

  const parent = dirname(skillsHome);
  const nonce = randomUUID();
  const stagingHome = join(parent, `.paperclip-skills-staging-${nonce}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await mkdir(stagingHome, { mode: 0o700 });
  try {
    for (const skill of context?.skills ?? []) {
      const target = safeMaterializationTarget(stagingHome, skill.runtimeName);
      await cp(skill.bundle.rootPath, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      await assertSafeTree(target);
      await protectStagedTree(target);
    }

    // The caller supplies a new isolated home for each provider launch. Never
    // move an existing assignment out of its canonical path: a failed bounded
    // rollback cannot portably guarantee that name is restored on every
    // filesystem. Publication therefore targets only a fresh destination.
    await renameTree(stagingHome, skillsHome);
  } catch (error) {
    // Cleanup is best effort and must not replace the publication failure that
    // explains why no runtime snapshot was installed.
    await removeMaterializedTree(stagingHome, removeTree).catch(() => undefined);
    throw error;
  }
}

async function readSourceCodexAuth(sourceAuth: string): Promise<Buffer | null> {
  const handle = await open(
    sourceAuth,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > 1024 * 1024) {
      throw new Error("source Codex auth file exceeds the 1 MiB limit");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Copy only Paperclip's value-free provider projection, never host tools or hooks. */
async function managedCodexProviderConfig(sourceHome?: string | null): Promise<Record<string, unknown>> {
  if (!sourceHome?.trim()) return {};
  const source = await readSourceCodexAuth(join(sourceHome, "config.toml"));
  if (!source) return {};
  let parsed;
  try { parsed = parseToml(source.toString("utf8")); } catch { return {}; }
  if (parsed.model_provider !== "paperclip") return {};
  const providers = parsed.model_providers as Record<string, unknown> | undefined;
  const provider = providers?.paperclip as Record<string, unknown> | undefined;
  if (!provider || typeof provider.base_url !== "string" || provider.wire_api !== "responses"
    || provider.requires_openai_auth !== false
    || (provider.env_key !== undefined && provider.env_key !== "PAPERCLIP_AI_PROVIDER_KEY")) {
    throw new Error("Invalid managed Codex provider configuration");
  }
  const url = new URL(provider.base_url);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || isPrivateEndpointHost(url.hostname))))) {
    throw new Error("Invalid managed Codex provider URL");
  }
  const headerBindings: Record<string, string> = {};
  if (provider.env_http_headers !== undefined) {
    const headers = provider.env_http_headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)
      || Object.keys(headers).length > CODEX_HEADER_ENV_KEYS.length) {
      throw new Error("Invalid managed Codex header bindings");
    }
    const names = new Set<string>();
    for (const [name, key] of Object.entries(headers)) {
      if (!isCodexHeaderName(name) || names.has(name.toLowerCase())
        || typeof key !== "string" || !CODEX_HEADER_ENV_KEYS.includes(key)) {
        throw new Error("Invalid managed Codex header bindings");
      }
      names.add(name.toLowerCase());
      headerBindings[name] = key;
    }
  }
  const target: Record<string, unknown> = {
    name: "Paperclip connection",
    base_url: provider.base_url,
    wire_api: "responses",
    requires_openai_auth: false,
    ...(provider.env_key ? { env_key: "PAPERCLIP_AI_PROVIDER_KEY" } : {}),
    ...(Object.keys(headerBindings).length ? { env_http_headers: headerBindings } : {}),
    ...(isOpenRouterUrl(provider.base_url) ? parseToml(openRouterCodexHeaders()) : {}),
  };
  const result: Record<string, unknown> = { model_provider: "paperclip", model_providers: { paperclip: target } };
  if (provider.name === "openai") {
    if (provider.supports_websockets !== true) throw new Error("Invalid managed Codex WebSocket capability");
    target.name = "openai";
    target.supports_websockets = true;
    // Derive both URLs from the validated endpoint, never accept an alternate destination.
    result.openai_base_url = provider.base_url;
    target.model_catalog_url = `${provider.base_url.replace(/\/+$/, "")}/models`;
    for (const key of ["supports_standalone_web_search"] as const) {
      if (typeof provider[key] !== "boolean") throw new Error("Invalid managed Codex capabilities");
      target[key] = provider[key];
    }
    if (!["disabled", "cached", "live"].includes(String(parsed.web_search))) throw new Error("Invalid managed Codex web search mode");
    if (typeof parsed.service_tier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(parsed.service_tier)) throw new Error("Invalid managed Codex service tier");
    result.web_search = parsed.web_search;
    result.service_tier = parsed.service_tier;
    result.analytics = { enabled: false };
    result.feedback = { enabled: false };
    const features = parsed.features as Record<string, unknown> | undefined;
    if (typeof features?.standalone_web_search !== "boolean") throw new Error("Invalid managed Codex feature flag");
    result.features = { api_key_model_discovery: true, standalone_web_search: features.standalone_web_search };
  }
  return result;
}

export async function prepareIsolatedCodexHome(input: {
  observability?: import("./agent-observability.js").ProviderObservabilityLaunch;
  context: NativeRuntimeContextSnapshot | null;
  codexHome: string;
  sourceCodexHome?: string | null;
  nativeMcp?: NativeMcpLaunchBinding | null;
  apiKey?: string | null;
}): Promise<void> {
  await materializeNativeRuntimeSkills(
    input.context,
    join(input.codexHome, "skills"),
  );

  const providerConfig = await managedCodexProviderConfig(input.sourceCodexHome);
  const configPath = join(input.codexHome, "config.toml");
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  await chmod(input.codexHome, 0o700);
  const temporaryConfig = join(input.codexHome, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryConfig, stringifyToml({
      ...providerConfig,
      ...(input.observability?.otelConfig ? { otel: input.observability.otelConfig } : {}),
      // Codex shell snapshots serialize the provider process environment. The
      // native runner injects short-lived provider and MCP bindings, so a
      // snapshot would turn ephemeral credentials into durable session state.
      features: { ...(providerConfig.features as Record<string, boolean> | undefined), shell_snapshot: false },
      mcp_servers: {
        ...(input.nativeMcp
          ? { [input.nativeMcp.name]: {
            url: input.nativeMcp.url,
            // This endpoint is Paperclip's authenticated policy gateway, not an
            // upstream server. It enforces connection grants and human approvals
            // for every operation; the provider must deliver calls to that gate.
            default_tools_approval_mode: "approve",
            http_headers: { Authorization: `Bearer ${input.nativeMcp.token}` },
          } }
          : {}),
      },
    }), { mode: 0o600, flag: "wx" });
    await rename(temporaryConfig, configPath);
    await chmod(configPath, 0o600);
  } finally { await rm(temporaryConfig, { force: true }); }

  const targetAuth = join(input.codexHome, "auth.json");
  await rm(targetAuth, { force: true });
  if (Object.keys(providerConfig).length) return;
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    // The pinned Codex app-server authenticates API-key automation through its
    // login cache rather than the CLI-only CODEX_API_KEY path. Keep this file
    // owner-only in the disposable session home.
    await writeFile(
      targetAuth,
      JSON.stringify({ OPENAI_API_KEY: apiKey }),
      { mode: 0o600 },
    );
    await chmod(targetAuth, 0o600);
    return;
  }

  const sourceHome = input.sourceCodexHome?.trim();
  if (!sourceHome) return;
  const sourceAuth = await readSourceCodexAuth(join(sourceHome, "auth.json"));
  if (!sourceAuth) return;
  await writeFile(targetAuth, sourceAuth, { mode: 0o600 });
  await chmod(targetAuth, 0o600);
}
