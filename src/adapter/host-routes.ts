/**
 * The `security.allowedHosts` list as a regular expression, for the platforms that route on the Host header before the
 * function runs (Vercel `has`/`missing` host conditions, the Cloudflare Worker). The expression accepts the same Host
 * values as `compileHostRules` (`server/hosts.ts`): a name, a name with a port, or a `*.` subdomain wildcard, matched
 * without regard to letter case. A test pins that parity over a table of hosts (`HOST-RE-*`), so the platform's answer
 * and the handler's answer cannot drift apart.
 *
 * @packageDocumentation
 */

/** Escapes one character for a regular expression. */
function escapeOne(character: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(character) ? `\\${character}` : character;
}

/**
 * A text matched without regard to case: each letter becomes a two-letter class, the other characters are escaped.
 * @internal
 */
function caseless(text: string): string {
  let out = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    out += lower === upper ? escapeOne(character) : `[${lower}${upper}]`;
  }
  return out;
}

/**
 * The regular expression source (no flags) that accepts the Host values one `allowedHosts` pattern accepts. Mirrors
 * `compileHostRules`: the port is split off at the last colon (after any bracketed IPv6 address), a pattern with a port
 * accepts only that port, a pattern without one accepts any port, and `*.example.com` needs at least one character
 * before `.example.com` in the name (the name has no colon).
 *
 * @param pattern One entry of `security.allowedHosts`.
 * @returns The source of an alternative (not anchored).
 * @throws TypeError for a pattern the handler refuses (empty, a bare `*`, whitespace, `/` or `@`).
 * @internal
 */
export function hostPatternSource(pattern: string): string {
  const lower = pattern.trim().toLowerCase();
  if (lower === "" || lower === "*" || /[\s/@]/.test(lower)) {
    throw new TypeError(`allowed host ${JSON.stringify(pattern)} is invalid.`);
  }
  const portAt = lower.lastIndexOf(":");
  const hasPort = portAt > lower.lastIndexOf("]") && portAt !== -1;
  const name = hasPort ? lower.slice(0, portAt) : lower;
  const nameSource = name.startsWith("*.") ? `[^:]+${caseless(name.slice(1))}` : caseless(name);
  const portSource = hasPort ? `:${caseless(lower.slice(portAt + 1))}` : "(?::[^:]*)?";
  return `${nameSource}${portSource}`;
}

/**
 * One anchored regular expression source for a whole `allowedHosts` list: it matches a Host the handler accepts.
 *
 * @param patterns The list (non-empty).
 * @returns The source, such as `^(?:example\.com(?::[^:]*)?|[^:]+\.example\.org(?::[^:]*)?)$`.
 * @internal
 */
export function hostListSource(patterns: readonly string[]): string {
  return `^(?:${patterns.map(hostPatternSource).join("|")})$`;
}
