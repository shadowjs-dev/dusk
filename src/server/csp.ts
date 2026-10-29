/** Token to write where the per-request nonce goes: `"{nonce}"`. @since 1.0.0 */
export const NONCE_TOKEN = "{nonce}";

/**
 * Options of the Content-Security-Policy builder.
 *
 * @example
 * const csp: CspOptions = { directives: { "img-src": ["'self'", "https://images.example.com"] } };
 * @since 1.0.0
 */
export interface CspOptions {
  /**
   * Directives to add or replace, name to sources. `true` writes a bare directive such as
   * `upgrade-insecure-requests`; an empty array removes a default directive. The source
   * `"{nonce}"` becomes `'nonce-<value>'` for the request.
   */
  readonly directives?: Readonly<Record<string, readonly string[] | true>>;
  /** Start from the strict defaults (see {@link defaultCspDirectives}). Default `true`. */
  readonly useDefaults?: boolean;
  /** Send `Content-Security-Policy-Report-Only` instead. Default `false`. */
  readonly reportOnly?: boolean;
  /** Adds `report-uri`. */
  readonly reportUri?: string;
}

/** Longest header the builder accepts, in characters. @since 1.0.0 */
export const MAX_CSP_LENGTH = 8192;

/**
 * The strict defaults: same-origin everything, scripts only from this origin or with the nonce,
 * no plugins, no framing, no foreign form targets.
 *
 * @returns A fresh directive map.
 * @example
 * const directives = { ...defaultCspDirectives(), "img-src": ["'self'", "https://img.example"] };
 * @since 1.0.0
 */
export function defaultCspDirectives(): Record<string, readonly string[] | true> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", NONCE_TOKEN],
    "style-src": ["'self'", NONCE_TOKEN],
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };
}

const DIRECTIVE_NAME = /^[a-z][a-z0-9-]*$/;
/** True when a source could end a directive or a policy, or start a new header line. */
function isForbiddenSource(source: string): boolean {
  for (const char of source) {
    const code = char.charCodeAt(0);
    if (char === ";" || char === "," || code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Builds the header value. The result is validated: directive names, and sources that could
 * smuggle another directive or policy (`;`, `,`, whitespace, control characters), are rejected.
 *
 * @param options The policy.
 * @param nonce The request's nonce; required when a source uses `{nonce}`.
 * @returns The header value.
 * @throws TypeError for an invalid directive or source, or when `{nonce}` is used without a nonce.
 * @throws RangeError when the result is longer than 8192 characters.
 * @example
 * buildCsp({}, "abc"); // "default-src 'self'; script-src 'self' 'nonce-abc'; ..."
 * @since 1.0.0
 */
export function buildCsp(options: CspOptions, nonce: string | undefined): string {
  const merged = new Map<string, readonly string[] | true>();
  if (options.useDefaults ?? true) {
    for (const [name, sources] of Object.entries(defaultCspDirectives())) merged.set(name, sources);
  }
  for (const [name, sources] of Object.entries(options.directives ?? {})) merged.set(name, sources);
  if (options.reportUri !== undefined) merged.set("report-uri", [options.reportUri]);
  const parts: string[] = [];
  for (const [name, sources] of merged) {
    if (!DIRECTIVE_NAME.test(name))
      throw new TypeError(
        __DEV__ ? `CSP directive ${JSON.stringify(name)} is invalid.` : "DUSK_CSP_1",
      );
    if (sources === true) {
      parts.push(name);
      continue;
    }
    if (sources.length === 0) continue;
    const written = sources.map((source) => {
      if (source === NONCE_TOKEN) {
        if (nonce === undefined)
          throw new TypeError(
            __DEV__ ? "CSP uses {nonce} but the request has no nonce." : "DUSK_CSP_3",
          );
        return `'nonce-${nonce}'`;
      }
      if (source === "" || isForbiddenSource(source)) {
        throw new TypeError(
          __DEV__ ? `CSP source ${JSON.stringify(source)} in ${name} is invalid.` : "DUSK_CSP_4",
        );
      }
      return source;
    });
    parts.push(`${name} ${written.join(" ")}`);
  }
  const header = parts.join("; ");
  if (header.length > MAX_CSP_LENGTH) {
    throw new RangeError(
      __DEV__
        ? `CSP header is ${header.length} characters; the limit is ${MAX_CSP_LENGTH}.`
        : "DUSK_CSP_2",
    );
  }
  return header;
}
