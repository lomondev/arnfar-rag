import pkg from "../../package.json" with { type: "json" };

/**
 * The service version, read from package.json rather than typed into a route handler.
 *
 * The previous `/health` returned a hardcoded "0.3.0" while package.json said "0.0.0" —
 * two sources of truth that had already drifted. There is exactly one now.
 */
export const SERVICE_VERSION: string = pkg.version;
