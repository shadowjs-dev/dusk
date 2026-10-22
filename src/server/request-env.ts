import type { EnvSource } from "./env";

/**
 * Small helpers of the request pipeline that more than one feature reads: the host's environment, the
 * peer address, the content negotiation and the loopback test. They read the runtime's host objects through
 * `Reflect` so no module needs a global type.
 * @internal
 */

/** The process environment, where the runtime has one. */
export function readProcessEnv(): EnvSource | undefined {
  const host: unknown = Reflect.get(globalThis, "process");
  if (typeof host !== "object" || host === null) return undefined;
  const env: unknown = Reflect.get(host, "env");
  return typeof env === "object" && env !== null ? sourceFromPlatform(env) : undefined;
}

/** Own string properties of a platform object (Workers bindings), as an environment source. */
export function sourceFromPlatform(platform: unknown): EnvSource {
  const source: Record<string, string> = {};
  if (typeof platform === "object" && platform !== null) {
    for (const key of Object.keys(platform)) {
      const value: unknown = Reflect.get(platform, key);
      if (typeof value === "string") source[key] = value;
    }
  }
  return source;
}

/** The peer address an adapter reports in the host object, if any. */
export function peerOf(platform: unknown): string | undefined {
  if (typeof platform !== "object" || platform === null) return undefined;
  const value: unknown = Reflect.get(platform, "clientAddress");
  return typeof value === "string" ? value : undefined;
}

/** True when the client prefers JSON over HTML. */
export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const json = accept.indexOf("application/json");
  if (json === -1) return false;
  const html = accept.indexOf("text/html");
  return html === -1 || json < html;
}

/** True for loopback host names, where browsers accept `Secure` cookies over http. */
export function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}
