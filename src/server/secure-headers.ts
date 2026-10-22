import type { SecureHeadersOptions } from "./types";

/** Default `Permissions-Policy`: powerful features off unless the app opts in. @since 1.0.0 */
export const DEFAULT_PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

/**
 * The headers added to every response, as name-value pairs, for the given options. A value of
 * `false` omits the header. HSTS is added only when `secure` (the request came over https).
 *
 * @param options Overrides.
 * @param secure Whether the request used https.
 * @returns The headers to set (unless the response already has them).
 * @example
 * secureHeaderEntries(undefined, true); // [["x-content-type-options", "nosniff"], ...]
 * @since 1.0.0
 */
export function secureHeaderEntries(
  options: SecureHeadersOptions | undefined,
  secure: boolean,
): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  const add = (
    name: string,
    value: false | string | undefined,
    fallback: string | undefined,
  ): void => {
    const effective = value === undefined ? fallback : value;
    if (effective !== undefined && effective !== false) entries.push([name, effective]);
  };
  add("x-content-type-options", options?.contentTypeOptions, "nosniff");
  add("referrer-policy", options?.referrerPolicy, "strict-origin-when-cross-origin");
  add("permissions-policy", options?.permissionsPolicy, DEFAULT_PERMISSIONS_POLICY);
  add("x-frame-options", options?.frameOptions, "SAMEORIGIN");
  add("cross-origin-opener-policy", options?.crossOriginOpenerPolicy, undefined);
  add("cross-origin-resource-policy", options?.crossOriginResourcePolicy, undefined);
  const hsts = options?.hsts;
  if (hsts !== undefined && hsts !== false && secure) {
    if (!Number.isInteger(hsts.maxAge) || hsts.maxAge < 0) {
      throw new RangeError("hsts.maxAge must be a non-negative integer.");
    }
    entries.push([
      "strict-transport-security",
      `max-age=${hsts.maxAge}${hsts.includeSubDomains === true ? "; includeSubDomains" : ""}${hsts.preload === true ? "; preload" : ""}`,
    ]);
  }
  return entries;
}
