/**
 * Where the browser finds rag-api.
 *
 * `NEXT_PUBLIC_*` values are substituted at BUILD time, so a literal
 * `http://localhost:7730` compiled into the bundle means exactly one thing to every
 * visitor: "port 7730 on the machine running the browser". Open the site from a phone or
 * a colleague's laptop and every request goes to that device's own localhost, where
 * nothing is listening. That is why the site worked only on the machine hosting it.
 *
 * So the default is resolved at RUNTIME instead, from the address the page was actually
 * loaded over: open `http://192.168.1.50:3000` and the API is `http://192.168.1.50:7730`.
 * No rebuild, no per-machine configuration, and it keeps working when the DHCP lease
 * changes the host's address.
 *
 * `NEXT_PUBLIC_RAG_API_URL` still wins when set — a real deployment behind a hostname or
 * a reverse proxy needs to say so explicitly, and derivation would be wrong there.
 *
 * The boundary is unchanged (CLAUDE.md): the browser talks only to rag-api. This changes
 * how it finds the address, not who it may call.
 */

/** Explicit override. Empty/unset means "derive from the current page". */
const CONFIGURED = process.env.NEXT_PUBLIC_RAG_API_URL?.trim() ?? "";

/** Port rag-api listens on, when the host is derived rather than configured. */
const PORT = process.env.NEXT_PUBLIC_RAG_API_PORT?.trim() || "7730";

function withoutTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Base URL for rag-api, with no trailing slash.
 *
 * Server-side (RSC, the dev server rendering the first paint) there is no page address to
 * derive from, so it falls back to loopback — correct there, because that code runs on the
 * same machine as the API. Every data fetch in this app happens in the browser, where the
 * derived value is the one that applies.
 */
export function apiBaseUrl(): string {
  if (CONFIGURED) return withoutTrailingSlash(CONFIGURED);
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}

/**
 * How the API address is described in the UI.
 *
 * Renders identically on the server and the client, which a raw `apiBaseUrl()` would not —
 * the server has no window to derive from, so React would hydrate over a different string
 * and warn.
 */
export function apiBaseUrlLabel(): string {
  return CONFIGURED ? withoutTrailingSlash(CONFIGURED) : `(this site's host):${PORT}`;
}
