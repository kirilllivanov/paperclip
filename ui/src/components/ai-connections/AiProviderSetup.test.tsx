// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { AiProviderSetup } from "./AiProviderSetup";
import { aiConnectionsApi } from "@/api/ai-connections";
import { TooltipProvider } from "@/components/ui/tooltip";
import { aiProviderSetupPreset } from "@paperclipai/shared";
import type { AiConnectionCredentialStep } from "./AiConnectionCredentialStep";

let credentialProps: ComponentProps<typeof AiConnectionCredentialStep> | undefined;
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { create: vi.fn(async () => ({ connectionId: "connection", grantId: "grant" })), list: vi.fn(async () => ({ currentUserId: "owner", connections: [], canManageConnections: true })) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));
vi.mock("./AiConnectionCredentialStep", () => ({ AiConnectionCredentialStep: (props: ComponentProps<typeof AiConnectionCredentialStep>) => { credentialProps = props; return <div>Existing credential flow</div>; } }));

it("reconnects an older OpenRouter account without adding routing metadata", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onComplete = vi.fn();
  const account = { id: "connection", grantId: "grant", companyId: "company", provider: "openrouter", method: "api_key", name: "Existing OpenRouter", ownership: "personal", ownerUserId: "owner", isDefault: true, status: "needs_attention" } as const;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" reconnect={account} onCancel={() => {}} onComplete={onComplete} /></QueryClientProvider>));
    expect(container.textContent).toContain("Existing credential flow");
    expect(credentialProps).toMatchObject({ connectionId: account.id, provider: "openrouter", initialMethod: "api_key", fixedMethod: true });
    credentialProps!.onComplete({ connectionId: account.id, grantId: account.grantId, method: "api_key" });
    expect(onComplete).toHaveBeenCalledWith({ provider: "openrouter", method: "api_key", mode: "delegated", connectionId: account.id, grantId: account.grantId });
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

const providerSources = ["openrouter", "bedrock", "responses-api", "codex-endpoint", "messages-api", "chat-completions-api", "local"];
it("reconnects an older Codex endpoint with the Codex name and header form", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const account = { id: "connection", grantId: "grant", companyId: "company", provider: "openai", method: "api_key", name: "My Codex", ownership: "personal", isDefault: false, status: "connected",
      routing: { kind: "gateway", protocol: "codex", auth: "bearer", baseUrl: "http://10.0.1.1:2455/backend-api/codex", models: [] } } as const;
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" providerLabel="Responses API"
      reconnect={{ ...account, routing: { ...account.routing, models: [] } }} onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    expect(container.textContent).toContain("Reconnect Codex endpoint");
    expect(container.textContent).not.toContain("Reconnect Responses API");
    expect(container.querySelector('input[aria-label="Bearer token"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Add HTTP header")).toBe(true);
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it("saves a private Codex backend with a Bearer token and secret headers", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  async function fill(label: string, value: string) {
    const input = container.querySelector(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider="codex" initialProtocol="responses" onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    await fill("Provider URL", "http://10.0.1.1:2455/backend-api/codex");
    await fill("Bearer token", "private-token");
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Add HTTP header")!.click());
    await fill("Header name 1", "ChatGPT-Account-Id");
    await fill("Header value 1", "private-account");
    expect(container.querySelector('input[aria-label="Header value 1"]')!.getAttribute("type")).toBe("password");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(aiConnectionsApi.create).toHaveBeenLastCalledWith("company", expect.objectContaining({
      provider: "openai", method: "api_key", apiKey: "private-token",
      routing: expect.objectContaining({ protocol: "codex", auth: "bearer", baseUrl: "http://10.0.1.1:2455/backend-api/codex" }),
      httpHeaders: [{ name: "ChatGPT-Account-Id", value: "private-account" }],
    }));
    expect((container.querySelector('input[aria-label="Bearer token"]') as HTMLInputElement).value).toBe("");
    expect(container.querySelector('input[aria-label="Header value 1"]')).toBeNull();
  } finally { await act(async () => root.unmount()); client.clear(); }
});

it("shows advanced providers directly when entered from advanced connection mode", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" advancedOnly onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    const choices = Array.from(container.querySelectorAll("button[aria-label]")).map(button => button.getAttribute("aria-label"));
    expect(choices).toEqual(["OpenRouter", "Amazon Bedrock", "Custom gateway", "Codex endpoint", "Local endpoint"]);
    expect(container.querySelector("details")).toBeNull();
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});

it.each(providerSources)("opens %s directly with shared access folded under Advanced", async source => {
  const preset = aiProviderSetupPreset(source)!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], [{ id: "agent", name: "Nova" }]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onCancel = vi.fn();
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><AiProviderSetup companyId="company" initialProvider={preset.provider} initialProtocol={preset.protocol} providerLabel={preset.label} onCancel={onCancel} onComplete={() => {}} /></TooltipProvider></QueryClientProvider>));
    expect(container.textContent).not.toContain("Connect a model provider");
    expect(container.textContent).toContain("Connects for everyone in your organization, available to all agents.");
    expect(container.querySelector('[role="radio"]')).toBeNull();
    const change = Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Change")!;
    expect(change.getAttribute("aria-expanded")).toBe("false");
    await act(async () => change.click());
    const radio = (text: string) => Array.from(container.querySelectorAll('[role="radio"]')).find(b => b.textContent?.includes(text)) as HTMLButtonElement;
    expect(radio("Any human in the organization").getAttribute("aria-checked")).toBe("true");
    expect(radio("Any agent").getAttribute("aria-checked")).toBe("true");
    await act(async () => radio("Just me").click());
    expect(container.textContent).toContain("Connects as you, available to all agents.");
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Back")!.click());
    expect(onCancel).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount()); container.remove(); client.clear();
  }
});

it("saves the default organization grant and all-agent installation from the direct connect screen", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: true, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider="openrouter" onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    const input = container.querySelector('input[aria-label="API key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(aiConnectionsApi.create).toHaveBeenCalledWith("company", expect.objectContaining({ ownership: "shared", allAgents: true, agentIds: [], apiKey: "fixture-key", routing: expect.objectContaining({ kind: "openrouter" }) }));
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});


it("allows an ordinary member to save a personal gateway before the agent exists", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: false, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onComplete = vi.fn();
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider="openrouter" onCancel={() => {}} onComplete={onComplete} /></QueryClientProvider>));
    const input = container.querySelector('input[aria-label="API key"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "member-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const connect = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(aiConnectionsApi.create).toHaveBeenCalledWith("company", expect.objectContaining({ ownership: "personal", allAgents: false, agentIds: [], apiKey: "member-key" }));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ mode: "delegated", connectionId: "connection", grantId: "grant" }));
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});


it.each(["google", "openai", "anthropic", "xai"] as const)("allows an ordinary member to connect a personal %s account before an agent exists", async provider => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connections", "company", undefined], { canManageConnections: false, connections: [] });
  client.setQueryData(["agents", "company", "provider-access"], []);
  const container = document.createElement("div");
  const root = createRoot(container);
  credentialProps = undefined;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AiProviderSetup companyId="company" initialProvider={provider} onCancel={() => {}} onComplete={() => {}} /></QueryClientProvider>));
    expect(credentialProps).toMatchObject({ provider, ownership: "personal", allAgents: false, agentIds: [], disabled: false });
  } finally {
    await act(async () => root.unmount()); client.clear();
  }
});
