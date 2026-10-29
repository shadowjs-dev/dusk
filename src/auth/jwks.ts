import { createRateLimiter } from "../server/rate-limit";
import { OidcError } from "./errors";
import { checkEndpointUrl, type FetchPolicy, fetchBounded, parseJsonObject, waitFor } from "./http";
import { importVerificationKey, type Jwk, type JwtHeader, keyTypeOf } from "./jwt";

/** Options of {@link createJwksCache}. @since 1.0.0 */
export interface JwksCacheOptions {
  /** Address of the key set (`jwks_uri`). */
  readonly uri: string;
  /** How long a fetched key set is trusted, in seconds. Default 600. */
  readonly ttlSeconds?: number;
  /**
   * Network fetches allowed in a burst; afterward one per `refillSeconds`. A fetch happens at start-up, when the set
   * expires and when a token names a key the cache does not know (the provider rotated), so an attacker who sends tokens with
   * random `kid` values cannot make the server call the provider more often than this. Default 3.
   */
  readonly fetchBurst?: number;
  /** Seconds between further fetches once the burst is used. Default 30. */
  readonly refillSeconds?: number;
  /** Time source in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A cache of the key set of one identity provider.
 * @since 1.0.0
 */
export interface JwksCache {
  /**
   * The verification key for a token header. A header with a `kid` selects the key with that id; a header without one is
   * accepted only when exactly one key of the right type exists. An unknown `kid` triggers one rate-limited refetch.
   */
  key(header: JwtHeader, policy: FetchPolicy): Promise<CryptoKey>;
  /** Forgets the cached key set. */
  clear(): void;
}

interface Snapshot {
  readonly keys: readonly Jwk[];
  readonly fetchedAt: number;
  readonly imported: Map<string, Promise<CryptoKey>>;
}

const MAX_KEYS = 100;

/**
 * Creates a JWKS cache: one shared in-flight fetch, a time to live, key rotation (an unknown `kid` refetches once), and a
 * limit on how often the provider is called whatever tokens arrive. Imported `CryptoKey` objects are cached with the set.
 * A failed fetch never falls back to an expired set.
 *
 * @param options Address, lifetime and fetch limits.
 * @returns The cache.
 * @throws RangeError for non-positive limits.
 * @example
 * const jwks = createJwksCache({ uri: "https://issuer.example/jwks" });
 * const { payload } = await verifyJwt(token, {
 *   algorithms: ["RS256"],
 *   key: (header) => jwks.key(header, policy),
 * });
 * @since 1.0.0
 */
export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const ttlMs = (options.ttlSeconds ?? 600) * 1000;
  const burst = options.fetchBurst ?? 3;
  const refill = options.refillSeconds ?? 30;
  if (!(ttlMs > 0)) throw new RangeError("ttlSeconds must be positive.");
  const now = options.now ?? Date.now;
  const limiter = createRateLimiter({ capacity: burst, refillPerSecond: 1 / refill, now });
  let snapshot: Snapshot | undefined;
  let inflight: Promise<Snapshot> | undefined;

  const fetchSet = async (policy: FetchPolicy): Promise<Snapshot> => {
    if (!(await limiter.check("jwks")).allowed) {
      throw new OidcError(
        "OIDC_JWKS_FAILED",
        "The key set was fetched too often; try again later.",
      );
    }
    const url = checkEndpointUrl(options.uri, "jwks_uri", policy.allowLoopbackHttp);
    const response = await fetchBounded(policy, url, {});
    const body = response.ok ? parseJsonObject(response.text) : undefined;
    const keys = body?.["keys"];
    if (!Array.isArray(keys)) {
      throw new OidcError(
        "OIDC_JWKS_FAILED",
        `The key set answered ${response.status} without keys.`,
      );
    }
    const usable = keys.filter(
      (entry): entry is Jwk =>
        typeof entry === "object" && entry !== null && typeof (entry as Jwk).kty === "string",
    );
    if (usable.length > MAX_KEYS)
      throw new OidcError("OIDC_JWKS_FAILED", "The key set is too large.");
    snapshot = { keys: usable, fetchedAt: now(), imported: new Map() };
    return snapshot;
  };

  const load = (policy: FetchPolicy): Promise<Snapshot> => {
    // The fetch is shared, so it ends by its own timeout only; each caller stops waiting on its own signal.
    inflight ??= fetchSet({ ...policy, signal: undefined }).finally(() => {
      inflight = undefined;
    });
    return waitFor(inflight, policy.signal);
  };

  const select = (set: Snapshot, header: JwtHeader): Array<readonly [number, Jwk]> => {
    const type = keyTypeOf(header.alg);
    const found: Array<readonly [number, Jwk]> = [];
    set.keys.forEach((jwk, index) => {
      if (jwk.kty !== type) return;
      if (header.kid !== undefined && jwk.kid !== header.kid) return;
      if (jwk.alg !== undefined && jwk.alg !== header.alg) return;
      if (jwk.use !== undefined && jwk.use !== "sig") return;
      found.push([index, jwk]);
    });
    return found;
  };

  return {
    async key(header, policy) {
      let set = snapshot;
      let fresh = false;
      if (set === undefined || now() - set.fetchedAt >= ttlMs) {
        set = await load(policy);
        fresh = true;
      }
      let found = select(set, header);
      if (found.length === 0 && header.kid !== undefined && !fresh) {
        // The provider may have rotated: look once more, within the fetch limit.
        try {
          set = await load(policy);
        } catch (error) {
          throw new OidcError("OIDC_ID_TOKEN_INVALID", "The token names a key that is not known.", {
            cause: error,
          });
        }
        found = select(set, header);
      }
      const match = found[0];
      if (match === undefined) {
        throw new OidcError("OIDC_ID_TOKEN_INVALID", "No key of the key set fits the token.");
      }
      if (found.length > 1) {
        throw new OidcError(
          "OIDC_ID_TOKEN_INVALID",
          header.kid === undefined
            ? "The token has no key id and the key set has several keys."
            : "The key set holds the key id more than once.",
        );
      }
      const [index, jwk] = match;
      const slot = `${index}:${header.alg}`;
      let key = set.imported.get(slot);
      if (key === undefined) {
        key = importVerificationKey(jwk, header.alg);
        set.imported.set(slot, key);
        key.catch(() => set.imported.delete(slot));
      }
      return key;
    },
    clear() {
      snapshot = undefined;
    },
  };
}
