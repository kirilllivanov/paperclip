// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantConnection, AssistantConnectionCard } from "./AssistantConnection";
import { ApiError } from "@/api/client";
import { AssistantConnectionsPage } from "../McpConnect";
const mocks = vi.hoisted(() => ({ setup: vi.fn(), connections: vi.fn(), revoke: vi.fn(), breadcrumbs: vi.fn(), copy: vi.fn() }));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/api/publicMcp", () => ({ publicMcpApi: mocks }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "butter", selectedCompany: { id: "butter", name: "Butter", logoUrl: null } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const grant = { id: "grant", companyId: "butter", companyName: "Butter", clientName: "OpenCode", user: { name: "Dotta", image: "/avatar.jpg" }, scopes: ["paperclip:read", "paperclip:write"], createdAt: "2026-10-05T00:00:00Z", revokedAt: null };
let root: Root, container: HTMLDivElement, client: QueryClient;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function render(element: React.ReactNode = <AssistantConnection initialAssistant="opencode" />) {
  await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  await flush();
}
beforeEach(() => {
  mocks.setup.mockResolvedValue({ enabled: true, serverUrl: "https://canonical.example/mcp/paperclip" });
  mocks.connections.mockResolvedValue([]);
  mocks.revoke.mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });
describe("assistant setup from Connections", () => {
  it("explains unavailable public MCP in the catalog without a retry or empty connection state", async () => {
    mocks.connections.mockRejectedValue(new ApiError("Not found", 404, null));
    await render(<AssistantConnectionCard onNavigate={vi.fn()} />);
    expect(container.textContent).toContain("public HTTPS URL");
    expect(container.textContent).toContain("localhost/loopback");
    expect(container.querySelector('a[href*="doc/public-mcp.md"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Try again");
    expect(container.textContent).not.toContain("Couldn’t load");
    expect(container.querySelector("[data-connected]")).toBeNull();
    expect(mocks.connections).toHaveBeenCalledTimes(1);
  });
  it.each(["setup", "connections"] as const)("shows deployment guidance when the %s endpoint is missing", async endpoint => {
    mocks[endpoint].mockRejectedValue(new ApiError("Not found", 404, null));
    await render();
    expect(container.textContent).toContain("public HTTPS URL");
    expect(container.querySelector('a[href*="doc/public-mcp.md"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Copy invitation"]')).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Try again");
    expect(container.textContent).not.toContain("Refresh");
    if (endpoint === "connections") expect(container.textContent).not.toContain("No assistants connected");
    expect(container.textContent).not.toContain("Couldn’t load");
  });
  it("explains unavailable public MCP on the account-wide management page", async () => {
    mocks.connections.mockRejectedValue(new ApiError("Not found", 404, null));
    await render(<AssistantConnectionsPage />);
    expect(container.textContent).toContain("public HTTPS URL");
    expect(container.querySelector('a[href*="doc/public-mcp.md"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Not found");
    expect(container.textContent).not.toContain("No assistant connections");
    expect(container.textContent).not.toContain("Try again");
  });
  it("stops polling after the connections endpoint returns 404", async () => {
    mocks.connections.mockRejectedValue(new ApiError("Not found", 404, null));
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><AssistantConnection /></QueryClientProvider>));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(container.textContent).toContain("public HTTPS URL");
      expect(mocks.connections).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(mocks.connections).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("keeps existing connections revocable when only the setup endpoint is missing", async () => {
    mocks.setup.mockRejectedValue(new ApiError("Not found", 404, null));
    mocks.connections.mockResolvedValue([grant]);
    await render();
    expect(container.textContent).toContain("public HTTPS URL");
    expect(container.querySelector('[aria-label="Copy invitation"]')).toBeNull();
    const revoke = container.querySelector<HTMLButtonElement>('[aria-label="Revoke Dotta’s OpenCode connection"]');
    expect(revoke).not.toBeNull();
    mocks.connections.mockResolvedValue([]);
    await act(async () => revoke!.click());
    await flush();
    expect(mocks.revoke).toHaveBeenCalledWith(grant.id, expect.anything());
    expect(container.querySelector('[aria-label="Revoke Dotta’s OpenCode connection"]')).toBeNull();
  });
  it("stops polling on a setup 404 after success and resumes when setup recovers", async () => {
    mocks.connections.mockResolvedValue([grant]);
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><AssistantConnection /></QueryClientProvider>));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(mocks.connections).toHaveBeenCalledTimes(1);
      mocks.setup.mockRejectedValue(new ApiError("Not found", 404, null));
      await act(async () => { await client.refetchQueries({ queryKey: ["mcp-setup"] }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(container.textContent).toContain("public HTTPS URL");
      expect(container.querySelector('[aria-label="Copy invitation"]')).toBeNull();
      expect(container.querySelector('[aria-label="Revoke Dotta’s OpenCode connection"]')).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(mocks.connections).toHaveBeenCalledTimes(1);
      mocks.setup.mockResolvedValue({ enabled: true, serverUrl: "https://canonical.example/mcp/paperclip" });
      await act(async () => { await client.refetchQueries({ queryKey: ["mcp-setup"] }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(container.textContent).not.toContain("public HTTPS URL");
      expect(container.querySelector('[aria-label="Copy invitation"]')).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(mocks.connections).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("does not treat a missing grant during revocation as unavailable public MCP", async () => {
    mocks.connections.mockResolvedValue([grant]);
    mocks.revoke.mockRejectedValueOnce(new ApiError("Not found", 404, null));
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Revoke Dotta’s OpenCode connection"]')!.click());
    await flush();
    expect(container.textContent).toContain("Couldn’t revoke this connection");
    expect(container.textContent).not.toContain("public HTTPS URL");
    expect(container.querySelector('[aria-label="Revoke Dotta’s OpenCode connection"]')).not.toBeNull();
  });
  it.each([401, 403, 500])("keeps HTTP %s failures distinct from unavailable public MCP", async status => {
    mocks.connections.mockRejectedValue(new ApiError("Request failed", status, null));
    await render(<AssistantConnectionCard onNavigate={vi.fn()} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load your connection status");
    expect(container.textContent).toContain("Try again");
    expect(container.textContent).not.toContain("public HTTPS URL");
    await render(<AssistantConnectionsPage />);
    expect(container.textContent).toContain("Request failed");
    expect(container.textContent).not.toContain("public HTTPS URL");
  });
  it("preserves sign-in guidance and retry for setup authorization errors", async () => {
    mocks.setup.mockRejectedValue(new ApiError("Unauthorized", 401, null));
    await render();
    expect(container.textContent).toContain("Sign in to connect an assistant");
    expect(container.textContent).toContain("Try again");
    expect(container.textContent).not.toContain("public HTTPS URL");
  });
  it("copies a scoped instruction link with no credential and keeps manual configuration collapsed", async () => {
    await render();
    expect(container.querySelector("details")?.open).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy invitation"]')!.click());
    expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringContaining("https://canonical.example/mcp/setup?company=butter"));
    expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringContaining("after I approve"));
    expect(document.body.textContent).toContain("Copied to clipboard");
    expect(container.textContent).not.toContain("Copy link");
    expect(container.textContent).not.toContain("Open setup instructions");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("surfaces catalog status failures and recovers without claiming there are no connections", async () => {
    mocks.connections.mockRejectedValue(new Error("offline"));
    await render(<AssistantConnectionCard onNavigate={vi.fn()} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load your connection status");
    expect(container.querySelector('[aria-label="Set up Assistant Connection (MCP)"]')).toBeNull();
    expect(container.querySelector('[data-connected]')).toBeNull();
    mocks.connections.mockResolvedValue([grant]);
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Try again")!.click());
    await flush();
    expect(container.querySelector('[aria-label="Manage Assistant Connection (MCP)"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("uses the canonical URL and explains how OpenCode opens consent without granting access", async () => {
    await render();
    const config = Array.from(container.querySelectorAll("pre")).map(p => p.textContent!).find(p => p.startsWith("{"))!;
    expect(JSON.parse(config).mcp.paperclip).toEqual({ type: "remote", url: "https://canonical.example/mcp/paperclip", enabled: true, oauth: { scope: "paperclip:read paperclip:write paperclip:configure offline_access" } });
    expect(container.textContent).toContain("opencode mcp auth paperclip");
    expect(container.textContent).toContain("No assistants connected to Butter yet");
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("shows the enable path while disabled, with no usable setup instructions", async () => {
    mocks.setup.mockResolvedValue({ enabled: false, serverUrl: "https://canonical.example/mcp/paperclip" });
    await render();
    expect(container.querySelector('a[href="/company/settings/instance/experimental"]')).not.toBeNull();
    expect(container.textContent).not.toContain("opencode mcp auth");
    expect(container.textContent).not.toContain("https://canonical.example");
  });
  it("only shows this organization’s grants and revokes the selected grant", async () => {
    mocks.connections.mockResolvedValue([grant, { ...grant, id: "other", companyId: "elsewhere", clientName: "Other secret client" }]);
    await render();
    expect(container.textContent).not.toContain("Other secret client");
    expect(container.textContent).toContain("Connected as you · Read and write");
    expect(container.textContent).toContain("Dotta’s OpenCode connection");
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    mocks.connections.mockResolvedValue([{ ...grant, revokedAt: "2026-10-05T00:00:00Z" }]);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Revoke Dotta’s OpenCode connection"]')!.click());
    await flush();
    expect(mocks.revoke.mock.calls[0]?.[0]).toBe("grant");
    expect(container.textContent).not.toContain("Revoked");
    expect(container.textContent).not.toContain("Dotta’s OpenCode connection");
    expect(container.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(container.textContent).toContain("No assistants connected to Butter yet");
    expect(container.querySelector('[aria-label="Copy first prompt"]')).toBeNull();
  });
  it("hides retained revoked grants in both the page and catalog card", async () => {
    mocks.connections.mockResolvedValue([{ ...grant, revokedAt: "2026-10-05T00:00:00Z" }]);
    await render();
    expect(container.textContent).toContain("No assistants connected to Butter yet");
    expect(container.textContent).not.toContain("Dotta’s OpenCode connection");
    await render(<AssistantConnectionCard onNavigate={vi.fn()} />);
    expect(container.querySelector('[aria-label="Set up Assistant Connection (MCP)"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Dotta’s OpenCode connection");
  });
  it.each(["https://assistant.example", "my_assistant", "Custom Assistant"])("preserves a custom client’s name: %s", async (clientName) => {
    mocks.connections.mockResolvedValue([{ ...grant, clientName }]);
    await render();
    expect(container.textContent).toContain(`Dotta’s ${clientName} connection`);
    expect(container.querySelector('button[aria-label^="Revoke Dotta’s"]')?.getAttribute("aria-label")).toBe(`Revoke Dotta’s ${clientName} connection`);
  });
  it("uses the person’s initials when they have no profile image", async () => {
    mocks.connections.mockResolvedValue([{ ...grant, user: { name: "Dotta", image: null } }]);
    await render();
    expect(container.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("DO");
    expect(container.textContent).toContain("Dotta’s OpenCode connection");
  });
  it("keeps an older server’s connection usable without profile metadata", async () => {
    mocks.connections.mockResolvedValue([{ ...grant, user: undefined }]);
    await render();
    expect(container.textContent).toContain("OpenCode connection");
    expect(container.querySelector('[aria-label="Revoke OpenCode connection"]')).not.toBeNull();
  });
  it("retains the connection when revocation fails", async () => {
    mocks.connections.mockResolvedValue([grant]);
    mocks.revoke.mockRejectedValueOnce(new Error("offline"));
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Revoke Dotta’s OpenCode connection"]')!.click());
    await flush();
    expect(container.textContent).toContain("Couldn’t revoke this connection");
    expect(container.textContent).toContain("Dotta’s OpenCode connection");
  });
  it("hides a successfully revoked connection even if the follow-up refresh fails", async () => {
    mocks.connections.mockResolvedValue([grant]);
    await render();
    mocks.connections.mockRejectedValue(new Error("offline"));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Revoke Dotta’s OpenCode connection"]')!.click());
    await flush();
    expect(mocks.revoke).toHaveBeenCalledWith("grant", expect.anything());
    expect(container.textContent).not.toContain("Dotta’s OpenCode connection");
  });
  it("shows a real grant when the list refreshes after assistant sign-in", async () => {
    await render();
    mocks.connections.mockResolvedValue([grant]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["mcp-connections"] }); });
    await flush();
    expect(container.textContent).toContain("Connected as you · Read and write");
    expect(container.querySelector('[aria-label="Copy first prompt"]')).toBeNull();
  });
  it("keeps Dot agent grants out of personal assistant setup and connected status", async () => {
    const dot = { ...grant, id: "dot", clientName: "Dedicated Dot", scopes: ["paperclip:agent", "offline_access"] };
    mocks.connections.mockResolvedValue([dot]);
    await render(<AssistantConnectionCard onNavigate={vi.fn()} />);
    expect(container.querySelector('[data-connected]')?.getAttribute("data-connected")).toBe("false");
    expect(container.textContent).not.toContain("Connected as you");
    await render();
    expect(container.textContent).toContain("No assistants connected to Butter yet");
    expect(container.textContent).not.toContain("Dedicated Dot");
    mocks.connections.mockResolvedValue([dot, grant]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["mcp-connections"] }); });
    await flush();
    expect(container.textContent).toContain("Connected as you · Read and write");
    expect(container.querySelector('[aria-label="Revoke Dotta’s OpenCode connection"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Dedicated Dot");
    expect(container.querySelector('[aria-label="Revoke Dotta’s Dedicated Dot connection"]')).toBeNull();
  });
  it("shows a recoverable error instead of pretending setup succeeded", async () => {
    mocks.setup.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load assistant setup");
    mocks.setup.mockResolvedValue({ enabled: true, serverUrl: "https://canonical.example/mcp/paperclip" });
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Try again")!.click());
    await flush();
    expect(container.textContent).toContain("opencode mcp auth paperclip");
  });
});
