// Kept in sync with shared/src/codex-endpoint.ts by provider routing tests.
// Runner is independently distributed and cannot depend on control-plane packages.
export const CODEX_HEADER_ENV_KEYS = Array.from({ length: 16 }, (_, i) => `PAPERCLIP_CODEX_HEADER_SECRET_${i}`);

export function isCodexHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
    && !/^(authorization|host|content-length|transfer-encoding|connection|upgrade|proxy-authorization|content-type|accept-encoding)$/i.test(name);
}

export function isPrivateEndpointHost(host: string): boolean {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168));
}
