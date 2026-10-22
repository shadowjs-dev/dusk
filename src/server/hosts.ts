/**
 * Compiles host patterns into a predicate. A pattern is a host name (`example.com`), a host name
 * with a port (`example.com:8443`) or a wildcard for subdomains (`*.example.com`, which does not
 * match `example.com` itself). A pattern without a port matches any port. Matching is
 * case-insensitive.
 *
 * @param patterns The allowed hosts.
 * @returns A function from `url.host` to allowed or not.
 * @throws TypeError for an empty pattern or a bare `*`.
 * @example
 * compileHostRules(["example.com", "*.example.com"])("api.example.com:443"); // true
 * @since 1.0.0
 */
export function compileHostRules(patterns: readonly string[]): (host: string) => boolean {
  const rules = patterns.map((pattern) => {
    const lower = pattern.trim().toLowerCase();
    if (lower === "" || lower === "*" || /[\s/@]/.test(lower)) {
      throw new TypeError(`allowed host ${JSON.stringify(pattern)} is invalid.`);
    }
    const portAt = lower.lastIndexOf(":");
    const hasPort = portAt > lower.lastIndexOf("]") && portAt !== -1;
    const name = hasPort ? lower.slice(0, portAt) : lower;
    const port = hasPort ? lower.slice(portAt + 1) : undefined;
    return {
      wildcard: name.startsWith("*."),
      name: name.startsWith("*.") ? name.slice(1) : name,
      port,
    };
  });
  return (host) => {
    const lower = host.toLowerCase();
    const portAt = lower.lastIndexOf(":");
    const hasPort = portAt > lower.lastIndexOf("]") && portAt !== -1;
    const name = hasPort ? lower.slice(0, portAt) : lower;
    const port = hasPort ? lower.slice(portAt + 1) : undefined;
    return rules.some((rule) => {
      if (rule.port !== undefined && rule.port !== port) return false;
      return rule.wildcard
        ? name.endsWith(rule.name) && name.length > rule.name.length
        : name === rule.name;
    });
  };
}

/** The origin a prerender sends its requests to, or why none can be chosen. @internal */
export type PrerenderOrigin =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly message: string };

/**
 * Picks the origin a prerender renders from. An origin given by the caller is used as it is. Without
 * one, `http://localhost` is used when the handler accepts that host (or has no host list); when
 * `allowedHosts` does not list it, the first listed host that is a plain name (no wildcard) is used,
 * so a production host list does not make the build fail with a bare 400. A list of wildcards only
 * has no host to choose, and the message names the list.
 *
 * @param allowedHosts The handler's `security.allowedHosts`, if it exposes them.
 * @param explicit The origin the caller configured, if any.
 * @returns The origin, or the reason there is none.
 * @internal
 */
export function choosePrerenderOrigin(
  allowedHosts: readonly string[] | undefined,
  explicit: string | undefined,
): PrerenderOrigin {
  if (explicit !== undefined) return { ok: true, origin: explicit };
  const fallback = "http://localhost";
  if (allowedHosts === undefined || compileHostRules(allowedHosts)("localhost")) {
    return { ok: true, origin: fallback };
  }
  const plain = allowedHosts.find((pattern) => !pattern.trim().startsWith("*"));
  if (plain === undefined) {
    return {
      ok: false,
      message: `security.allowedHosts (${JSON.stringify(allowedHosts)}) has only wildcard patterns, so there is no host to prerender from; set the prerender origin to a host they allow.`,
    };
  }
  return { ok: true, origin: `http://${plain.trim()}` };
}

/**
 * Explains a 400 answer of a prerender request when the cause is the host check: the host the
 * request used is not in `allowedHosts`. Returns `undefined` when the host is allowed (the 400 has
 * another cause) or the handler has no host list.
 *
 * @param allowedHosts The handler's `security.allowedHosts`, if it exposes them.
 * @param origin The origin the request used.
 * @returns A sentence naming the option and the host, or `undefined`.
 * @internal
 */
export function hostRejectionMessage(
  allowedHosts: readonly string[] | undefined,
  origin: string,
): string | undefined {
  if (allowedHosts === undefined) return undefined;
  const host = new URL(origin).host;
  if (compileHostRules(allowedHosts)(host)) return undefined;
  return `the host ${JSON.stringify(host)} is not in security.allowedHosts (${JSON.stringify(allowedHosts)}); set the prerender origin to an allowed host.`;
}

/**
 * The host patterns a handler exposes as `allowedHosts` (see `DuskHandler`), or `undefined` for
 * a handler that does not expose them or accepts any host.
 *
 * @param handler Any handler object.
 * @returns The patterns, if they are a list of strings.
 * @internal
 */
export function allowedHostsOf(handler: object): readonly string[] | undefined {
  const value: unknown = Reflect.get(handler, "allowedHosts");
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as readonly string[])
    : undefined;
}
