import { env } from "./env.ts";

/**
 * Which browser origins may call this API.
 *
 * The base case is the explicit CORS_ORIGINS allowlist. When the service is served over a
 * local network, that list stops being practical: the origin is whatever address the
 * visitor typed, and a DHCP lease renewal changes it. CORS_ALLOW_PRIVATE_NETWORK widens
 * it to any origin on a private address instead — still bounded, because a public site can
 * never present one.
 *
 * What this does NOT do is protect the API. Same-origin policy is enforced by browsers;
 * curl ignores it entirely. Widening CORS is about letting the Studio work from a phone,
 * not about who can reach the data — that is the bind address, and ultimately the auth
 * layer this service does not yet have.
 */

/** RFC1918 + loopback + link-local, i.e. addresses that cannot be routed from the internet. */
const PRIVATE_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[?::1\]?)$/;

export function isPrivateOrigin(origin: string): boolean {
  try {
    return PRIVATE_HOST.test(new URL(origin).hostname);
  } catch {
    return false; // unparseable Origin header — refuse rather than guess
  }
}

/**
 * Origin predicate for `@elysiajs/cors`.
 *
 * Elysia hands the Request; the header is absent for same-origin and non-browser calls,
 * which need no CORS decision at all.
 */
export function corsOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (env.corsOrigins.includes(origin)) return true;
  return env.corsAllowPrivateNetwork && isPrivateOrigin(origin);
}
