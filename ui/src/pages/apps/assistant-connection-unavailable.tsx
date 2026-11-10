import { ApiError } from "@/api/client";

// Only use for the static setup/connections endpoints. A missing consent
// request or grant does not mean that public MCP is unavailable.
export function isAssistantConnectionUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function AssistantConnectionUnavailable() {
  return <div role="status" className="space-y-2 text-sm text-muted-foreground">
    <p>Assistant connections are unavailable on this instance. They require an authenticated instance with a public HTTPS URL. HTTP is supported only for localhost/loopback development.</p>
    <p>Ask your instance administrator to configure the public URL and restart the server. <a className="underline" href="https://github.com/paperclipai/paperclip/blob/master/doc/public-mcp.md#enable-an-instance" target="_blank" rel="noreferrer">Deployment documentation</a></p>
  </div>;
}
