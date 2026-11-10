import { useQuery } from "@tanstack/react-query";
import { aiRoutingModel, type AiConnectionBinding, type AiProviderRouting } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectionModels(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  harness: string,
  agentId?: string,
  environmentId?: string | null,
) {
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId && binding),
  });
  const connection = accounts.data?.connections.find((c) =>
    binding?.mode === "responsible_user"
      ? c.provider === binding.provider && c.isDefault && c.ownerUserId === accounts.data?.currentUserId && c.ownership === "personal"
      : c.id === binding?.connectionId && c.grantId === binding?.grantId,
  );
  const routing = connection?.routing;
  const openRouter = routing?.kind === "openrouter" || (!routing && binding?.provider === "openrouter");
  const codexEndpoint = routing?.protocol === "codex" && harness === "codex_local";
  const discover = (openRouter || codexEndpoint) && !routing?.models.length;
  // Reuse the existing public catalog and its query cache. It returns OpenCode IDs;
  // strip only that transport prefix for other harnesses (openrouter/auto is
  // itself a valid upstream model ID).
  const catalog = useQuery({
    queryKey: codexEndpoint
      ? [...queryKeys.agents.adapterModels(companyId ?? "none", "paperclip_runner", environmentId ?? null, "codex"), binding, agentId, routing]
      : queryKeys.agents.adapterModels(companyId ?? "none", "opencode_local", null, "openrouter"),
    queryFn: () => codexEndpoint
      ? agentsApi.adapterModels(companyId!, "paperclip_runner", { provider: "codex", aiConnection: binding, ...(agentId ? { agentId } : {}), ...(environmentId !== undefined ? { environmentId } : {}) })
      : agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: Boolean(companyId && discover),
    staleTime: 60_000,
    retry: false,
  });
  const effectiveRouting: AiProviderRouting | undefined = routing ?? (openRouter
    ? { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] }
    : undefined);
  const modelOptions = discover
    ? (catalog.data ?? []).map((m) => ({ ...m, id: codexEndpoint || ["opencode_local", "pi_local"].includes(harness) ? m.id : m.id.replace(/^openrouter\//, "") }))
    : routing?.models ?? [];
  return effectiveRouting
    ? {
        models: modelOptions.map((m) => ({
          id: aiRoutingModel(effectiveRouting, harness, m.id),
          label: m.label ?? m.id,
        })),
        isLoading: discover && catalog.isLoading,
        error: discover ? catalog.error : null,
        refreshing: discover && catalog.isFetching,
        refreshModels: discover ? async () => { await catalog.refetch(); } : undefined,
        resolveModel: (model: string) =>
          aiRoutingModel(effectiveRouting, harness, model),
      }
    : undefined;
}
