import { base64UrlEncode, randomToken, utf8 } from "../internal/encoding";
import { HttpError } from "../internal/http-error";
import { checkRedirectTarget, RedirectBlockedError } from "../server/redirect-target";
import { type Session, type SessionManager, signIn } from "../server/session";
import type { RequestEvent } from "../server/types";
import {
  isOidcError,
  OidcError,
  type OidcErrorCode,
  safeProviderDescription,
  safeProviderError,
} from "./errors";
import {
  checkEndpointUrl,
  type FetchPolicy,
  fetchBounded,
  isLoopbackHost,
  parseJsonObject,
} from "./http";
import { createJwksCache, type JwksCache } from "./jwks";
import {
  importHmacKey,
  isHmacAlgorithm,
  isSupportedAlgorithm,
  type JwsAlgorithm,
  verifyJwt,
} from "./jwt";

/** Endpoints of an identity provider that is configured by hand instead of discovered. @since 1.0.0 */
export interface OidcEndpoints {
  /** Where the browser is sent to sign in (`authorization_endpoint`). */
  readonly authorization: string;
  /** Where the code is exchanged (`token_endpoint`). */
  readonly token: string;
  /** The key set (`jwks_uri`). Required for OpenID Connect, not used by plain OAuth 2.0. */
  readonly jwks?: string;
  /** Profile (`userinfo_endpoint`). */
  readonly userinfo?: string;
  /** RP-initiated logout (`end_session_endpoint`). */
  readonly endSession?: string;
  /** Token revocation (`revocation_endpoint`, RFC 7009). */
  readonly revocation?: string;
}

/** How the client proves itself at the token endpoint. @since 1.0.0 */
export type OidcClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/** Options of {@link createOidcClient}. @since 1.0.0 */
export interface OidcClientOptions {
  /**
   * A name for this provider; it keys the data the client keeps in the session, so two clients (Google and GitHub) can
   * live in one app. Default `"oidc"`.
   */
  readonly name?: string;
  /**
   * The issuer URL. Without `endpoints` it is also where discovery reads `/.well-known/openid-configuration`, and it is
   * the only `iss` an ID token may carry. `https` only (`http://localhost` in development).
   */
  readonly issuer?: string;
  /** Endpoints set by hand; discovery is skipped. */
  readonly endpoints?: OidcEndpoints;
  /**
   * Replaces the exact comparison of `iss` for providers whose issuer depends on the tenant of the user (Microsoft Entra
   * with `common`). It must accept only issuers you trust; a regular expression anchored at both ends is the usual form.
   */
  readonly issuerMatches?: (issuer: string) => boolean;
  /** Your registered client id. */
  readonly clientId: string;
  /** The client secret of a confidential client. Absent: a public client (PKCE only). */
  readonly clientSecret?: string;
  /** The registered redirect URI: the address of your callback route. `https` (or `http://localhost` in development). */
  readonly redirectUri: string;
  /** Scopes requested. OpenID Connect needs `openid`. Default `["openid", "profile", "email"]`. */
  readonly scopes?: readonly string[];
  /** The session manager that keeps the sign-in transaction and the signed-in user. */
  readonly sessions: SessionManager;
  /** Plain OAuth 2.0: the provider issues no ID token, and the profile is read from the userinfo endpoint. */
  readonly oauth2?: boolean;
  /** Default `client_secret_basic` with a secret, `none` without. */
  readonly tokenEndpointAuthMethod?: OidcClientAuthMethod;
  /**
   * Signature algorithms accepted for ID tokens. Default `["RS256", "ES256", "PS256", "EdDSA"]`. `HS256`, `HS384` and
   * `HS512` are accepted only for a confidential client and only when listed here; the client secret is the key.
   */
  readonly idTokenAlgorithms?: readonly JwsAlgorithm[];
  /** Allowed difference between the clocks of the provider and this server, in seconds. Default 60. */
  readonly clockSkewSeconds?: number;
  /** Extra query parameters on every authorization request (for example `audience` for Auth0). */
  readonly authorizationParams?: Readonly<Record<string, string>>;
  /** Turns the raw userinfo answer into claims with a `sub`; for providers that do not follow OpenID Connect. */
  readonly mapUserinfo?: (
    raw: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  /** Refuse a callback without the `iss` parameter (RFC 9207). Default: required when discovery says the provider sends it. */
  readonly requireIssParameter?: boolean;
  /**
   * OpenID Connect only: also read the userinfo endpoint at sign-in and merge its claims over those of the ID token (its
   * `sub` must match). Plain OAuth 2.0 always reads it. Default `false`.
   */
  readonly fetchUserinfo?: boolean;
  /** Keep the tokens in the session (needed for refresh, userinfo and `id_token_hint`). Default `true`. */
  readonly storeTokens?: boolean;
  /** Session key of the signed-in user. Default `"user"`. The tokens use `<key>:tokens`. */
  readonly sessionKey?: string;
  /** Seconds a sign-in may take between redirect and callback. Default 600. */
  readonly transactionSeconds?: number;
  /** Seconds a discovery document is reused. Default 3600. */
  readonly discoverySeconds?: number;
  /** Seconds a key set is reused. Default 600. */
  readonly jwksSeconds?: number;
  /** Time limit of every call to the provider, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  /** Largest answer read from the provider, in bytes. Default 1 048 576. */
  readonly maxResponseBytes?: number;
  /** The `fetch` used for the provider. Default the platform `fetch`. */
  readonly fetch?: typeof fetch;
  /** Time source in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** Tokens the provider issued. @since 1.0.0 */
export interface OidcTokens {
  readonly accessToken: string;
  /** Milliseconds since epoch when the access token expires, when the provider said. */
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly scope?: string;
}

/** The signed-in user, as kept in the session. @since 1.0.0 */
export interface OidcUser {
  /** The `sub` claim: stable and unique within `issuer`. Use `issuer` and `id` together as the key of your own user table. */
  readonly id: string;
  /** The issuer (or the name of a plain OAuth 2.0 provider). */
  readonly issuer: string;
  readonly name?: string;
  readonly email?: string;
  /** Whether the provider says the address was verified. Do not link accounts by e-mail unless it is `true`. */
  readonly emailVerified?: boolean;
  readonly picture?: string;
  readonly username?: string;
}

/** What {@link OidcClient.callback} returns. @since 1.0.0 */
export interface OidcCallbackResult {
  readonly tokens: OidcTokens;
  /** The verified claims of the ID token; `undefined` for plain OAuth 2.0. */
  readonly claims: Readonly<Record<string, unknown>> | undefined;
  /** The userinfo answer, when it was read. */
  readonly userinfo: Readonly<Record<string, unknown>> | undefined;
  readonly user: OidcUser;
  /** Where to send the visitor now: the `returnTo` of the sign-in, checked twice. */
  readonly returnTo: string;
}

/** Options of {@link OidcClient.authorize}. @since 1.0.0 */
export interface OidcAuthorizeOptions {
  /** Where to go after sign-in. A path of this site; anything else is replaced by `/`. */
  readonly returnTo?: string;
  /** Overrides the scopes of the client for this sign-in. */
  readonly scopes?: readonly string[];
  /** Extra authorization parameters (`prompt`, `login_hint`, `max_age`, ...). The protocol parameters cannot be set. */
  readonly params?: Readonly<Record<string, string>>;
}

/** Options of {@link OidcClient.logoutUrl} and {@link OidcClient.signOut}. @since 1.0.0 */
export interface OidcLogoutOptions {
  /** Where the provider sends the visitor after logout: a path of this site or a URL of this origin. Register it at the provider. */
  readonly postLogoutRedirectUri?: string;
  /** Opaque value the provider returns with the visitor. */
  readonly state?: string;
  /** For `signOut`: revoke the refresh token at the provider first (best effort). Default `true`. */
  readonly revoke?: boolean;
}

/** The OpenID Connect client. @since 1.0.0 */
export interface OidcClient {
  /** The session key of the signed-in user. */
  readonly sessionKey: string;
  /** Starts a sign-in: stores state, nonce and the PKCE verifier in the session and answers with the redirect to the provider. */
  authorize(event: RequestEvent, options?: OidcAuthorizeOptions): Promise<Response>;
  /** Finishes a sign-in: validates the callback and the tokens. Does not sign the visitor in; see {@link OidcClient.signIn}. */
  callback(event: RequestEvent): Promise<OidcCallbackResult>;
  /** Signs the visitor in: a new session id, then the user (and the tokens) in the session. */
  signIn(event: RequestEvent, result: OidcCallbackResult): Promise<void>;
  /** `callback`, `signIn` and the redirect to `returnTo` in one call. */
  handleCallback(event: RequestEvent): Promise<Response>;
  /** The signed-in user of this request, or `undefined`. */
  user(event: RequestEvent): Promise<OidcUser | undefined>;
  /** Exchanges the refresh token for new tokens and stores them. Concurrent calls with the same token share one exchange. */
  refresh(event: RequestEvent): Promise<OidcTokens>;
  /** A usable access token, refreshed when it expires within `leewaySeconds` (default 30); `undefined` when not signed in. */
  accessToken(
    event: RequestEvent,
    options?: { readonly leewaySeconds?: number },
  ): Promise<string | undefined>;
  /** Reads the userinfo endpoint with the stored access token. */
  userinfo(event: RequestEvent): Promise<Readonly<Record<string, unknown>>>;
  /** The RP-initiated logout URL (OpenID Connect RP-Initiated Logout 1.0), or `undefined` when the provider has none. */
  logoutUrl(event: RequestEvent, options?: OidcLogoutOptions): Promise<string | undefined>;
  /** Signs out: revokes the refresh token, destroys the session, redirects to the provider's logout or to the local target. */
  signOut(event: RequestEvent, options?: OidcLogoutOptions): Promise<Response>;
}

const DEFAULT_ALGORITHMS: readonly JwsAlgorithm[] = ["RS256", "ES256", "PS256", "EdDSA"];
const RESERVED_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
]);
const MAX_TRANSACTIONS = 8;
const MAX_RETURN_TO = 2048;
const REFRESH_REUSE_MS = 30_000;

interface Transaction {
  /** state */
  readonly s: string;
  /** nonce */
  readonly n: string | undefined;
  /** PKCE verifier */
  readonly v: string;
  /** returnTo */
  readonly r: string;
  /** expires at (ms) */
  readonly e: number;
}

interface Resolved {
  readonly authorization: URL;
  readonly token: URL;
  readonly jwks: URL | undefined;
  readonly userinfo: URL | undefined;
  readonly endSession: URL | undefined;
  readonly revocation: URL | undefined;
  readonly algorithms: readonly string[] | undefined;
  readonly issParameter: boolean;
}

interface StoredTokens {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly scope?: string;
}

/** Compares two strings in time that depends only on their length, and on the longer one. @internal */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = utf8(left);
  const b = utf8(right);
  let diff = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function configError(message: string): TypeError {
  return new TypeError(`createOidcClient(): ${message}`);
}

function redirectResponse(location: string, status = 302): Response {
  // Characters outside printable ASCII are percent-encoded so no value can fail header validation.
  const encoded = location.replace(/[^\x21-\x7e]/g, (char) => encodeURIComponent(char));
  return new Response(null, {
    status,
    headers: { location: encoded, "cache-control": "no-store" },
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const toBoolean = (value: unknown): boolean | undefined =>
  value === true || value === "true"
    ? true
    : value === false || value === "false"
      ? false
      : undefined;

/** The hash used for `at_hash` for an algorithm (OpenID Connect Core section 3.1.3.6). */
function hashOf(alg: string): string {
  if (alg === "EdDSA") return "SHA-512";
  return `SHA-${alg.slice(2)}`;
}

/** Normalizes the claims of an ID token and of the userinfo answer into the user kept in the session. */
function toUser(issuer: string, claims: Readonly<Record<string, unknown>>, sub: string): OidcUser {
  const name = text(claims["name"]);
  const email = text(claims["email"]);
  const emailVerified = toBoolean(claims["email_verified"]);
  const picture = text(claims["picture"]);
  const username = text(claims["preferred_username"]) ?? text(claims["nickname"]);
  return {
    id: sub,
    issuer,
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(emailVerified === undefined ? {} : { emailVerified }),
    ...(picture === undefined ? {} : { picture }),
    ...(username === undefined ? {} : { username }),
  };
}

/**
 * Creates an OAuth 2.1 / OpenID Connect client for the authorization code flow with PKCE. It is strict by default: the
 * issuer and every endpoint must be `https` (`http://localhost` only in development), state, nonce and the PKCE verifier are
 * random and live in the server-side session for ten minutes and one use, the ID token is verified (signature through the
 * JWKS, `iss`, `aud`, `azp`, `exp`, `nbf`, `iat`, `nonce`, `at_hash`) against an algorithm allowlist, every call to the
 * provider has a timeout, no redirects and a 1 MiB cap, and the key set is fetched at most a few times whatever tokens arrive.
 *
 * @param options Provider, client registration and the session manager.
 * @returns The client.
 * @throws TypeError for a configuration that cannot work or cannot be safe (a missing issuer, an `http` redirect URI, `HS256` for a public client).
 * @example
 * const oidc = createOidcClient({
 *   issuer: "https://accounts.google.com",
 *   clientId: env.GOOGLE_ID,
 *   clientSecret: env.GOOGLE_SECRET,
 *   redirectUri: "https://app.example/auth/callback",
 *   sessions,
 * });
 * export const GET = (event: RequestEvent) => oidc.authorize(event, { returnTo: "/" });
 * @since 1.0.0
 */
export function createOidcClient(options: OidcClientOptions): OidcClient {
  const name = options.name ?? "oidc";
  const oauth2 = options.oauth2 === true;
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;
  if (typeof clientId !== "string" || clientId === "") throw configError("clientId is required.");
  if (clientSecret === "")
    throw configError("clientSecret must not be empty; leave it out for a public client.");
  if (options.issuer === undefined && options.endpoints === undefined) {
    throw configError("give `issuer` (discovery) or `endpoints`.");
  }
  if (options.issuer !== undefined) {
    if (!URL.canParse(options.issuer)) throw configError("issuer is not a URL.");
    const parsed = new URL(options.issuer);
    if (parsed.search !== "" || parsed.hash !== "")
      throw configError("issuer must not have a query or a fragment.");
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    ) {
      throw configError(
        "issuer must use https (http is allowed only for localhost in development).",
      );
    }
  }
  if (!oauth2) {
    if (options.issuer === undefined && options.issuerMatches === undefined) {
      throw configError(
        "OpenID Connect needs the expected `issuer` (or `issuerMatches`) to validate the ID token.",
      );
    }
    if (options.endpoints !== undefined && options.endpoints.jwks === undefined) {
      throw configError("endpoints.jwks is required for OpenID Connect.");
    }
  }
  if (!URL.canParse(options.redirectUri)) throw configError("redirectUri is not a URL.");
  const redirect = new URL(options.redirectUri);
  if (
    redirect.hash !== "" ||
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && isLoopbackHost(redirect.hostname)))
  ) {
    throw configError(
      "redirectUri must be an https URL without a fragment (http only for localhost in development).",
    );
  }
  const scopes = options.scopes ?? (oauth2 ? [] : ["openid", "profile", "email"]);
  if (!oauth2 && !scopes.includes("openid"))
    throw configError("scopes must include `openid` for OpenID Connect.");
  const algorithms = options.idTokenAlgorithms ?? DEFAULT_ALGORITHMS;
  for (const alg of algorithms) {
    if (!isSupportedAlgorithm(alg))
      throw configError(`unsupported ID token algorithm ${JSON.stringify(alg)}.`);
    if (isHmacAlgorithm(alg) && clientSecret === undefined) {
      throw configError(
        `${alg} needs a client secret; a public client cannot use a shared-secret algorithm.`,
      );
    }
  }
  const method: OidcClientAuthMethod =
    options.tokenEndpointAuthMethod ??
    (clientSecret === undefined ? "none" : "client_secret_basic");
  if (method !== "none" && clientSecret === undefined) {
    throw configError(`${method} needs a client secret.`);
  }
  const skew = options.clockSkewSeconds ?? 60;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxResponseBytes ?? 1_048_576;
  const transactionMs = (options.transactionSeconds ?? 600) * 1000;
  const discoveryMs = (options.discoverySeconds ?? 3600) * 1000;
  for (const [label, value] of [
    ["clockSkewSeconds", skew],
    ["timeoutMs", timeoutMs],
    ["maxResponseBytes", maxBytes],
    ["transactionSeconds", transactionMs],
    ["discoverySeconds", discoveryMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || (label !== "clockSkewSeconds" && value <= 0)) {
      throw configError(`${label} must be a positive number.`);
    }
  }
  for (const key of Object.keys(options.authorizationParams ?? {})) {
    if (RESERVED_PARAMS.has(key)) throw configError(`authorizationParams cannot set ${key}.`);
  }
  const sessions = options.sessions;
  const now = options.now ?? Date.now;
  const userKey = options.sessionKey ?? "user";
  const tokensKey = `${userKey}:tokens`;
  const txKey = `oidc:tx:${name}`;
  const storeTokens = options.storeTokens !== false;
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const jwks: { cache: JwksCache | undefined } = { cache: undefined };
  const hmacKeys = new Map<string, Promise<CryptoKey>>();
  const recentRefresh = new Map<
    string,
    { readonly promise: Promise<StoredTokens>; until: number }
  >();

  const policyOf = (event: RequestEvent): FetchPolicy => ({
    fetch: fetchImpl,
    timeoutMs,
    maxBytes,
    allowLoopbackHttp: event.dev,
    signal: event.signal,
  });

  // ---- endpoints and discovery -------------------------------------------------------------------

  let discovered: { readonly value: Resolved; readonly at: number } | undefined;
  let discovery: Promise<Resolved> | undefined;
  let retryAfter = 0;

  const resolveStatic = (event: RequestEvent, endpoints: OidcEndpoints): Resolved => {
    const loopback = event.dev;
    const url = (value: string | undefined, label: string): URL | undefined =>
      value === undefined ? undefined : checkEndpointUrl(value, label, loopback);
    return {
      authorization: checkEndpointUrl(endpoints.authorization, "authorization endpoint", loopback),
      token: checkEndpointUrl(endpoints.token, "token endpoint", loopback),
      jwks: url(endpoints.jwks, "jwks endpoint"),
      userinfo: url(endpoints.userinfo, "userinfo endpoint"),
      endSession: url(endpoints.endSession, "end session endpoint"),
      revocation: url(endpoints.revocation, "revocation endpoint"),
      algorithms: undefined,
      issParameter: false,
    };
  };

  const discover = async (event: RequestEvent): Promise<Resolved> => {
    const issuer = options.issuer as string;
    const policy = policyOf(event);
    const base = checkEndpointUrl(issuer, "issuer", policy.allowLoopbackHttp);
    const address = new URL(`${base.href.replace(/\/$/, "")}/.well-known/openid-configuration`);
    const response = await fetchBounded(policy, address, {});
    const document = response.ok ? parseJsonObject(response.text) : undefined;
    if (document === undefined) {
      throw new OidcError(
        "OIDC_DISCOVERY_FAILED",
        `Discovery answered ${response.status} without a document.`,
      );
    }
    // OpenID Connect Discovery 1.0 section 4.3: the issuer in the document must be exactly the one asked for.
    if (document["issuer"] !== issuer) {
      throw new OidcError("OIDC_DISCOVERY_FAILED", "The discovery document names another issuer.");
    }
    const endpoint = (key: string, required: boolean): URL | undefined => {
      const value = document[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== "string") {
        throw new OidcError(
          "OIDC_DISCOVERY_FAILED",
          `The discovery document has no usable ${key}.`,
        );
      }
      return checkEndpointUrl(value, key, policy.allowLoopbackHttp);
    };
    const methods = document["code_challenge_methods_supported"];
    if (Array.isArray(methods) && !methods.includes("S256")) {
      throw new OidcError("OIDC_DISCOVERY_FAILED", "The provider does not support PKCE with S256.");
    }
    const algs = document["id_token_signing_alg_values_supported"];
    return {
      authorization: endpoint("authorization_endpoint", true) as URL,
      token: endpoint("token_endpoint", true) as URL,
      jwks: endpoint("jwks_uri", !oauth2),
      userinfo: endpoint("userinfo_endpoint", false),
      endSession: endpoint("end_session_endpoint", false),
      revocation: endpoint("revocation_endpoint", false),
      algorithms: Array.isArray(algs)
        ? algs.filter((a): a is string => typeof a === "string")
        : undefined,
      issParameter: document["authorization_response_iss_parameter_supported"] === true,
    };
  };

  const endpointsOf = async (event: RequestEvent): Promise<Resolved> => {
    if (options.endpoints !== undefined) return resolveStatic(event, options.endpoints);
    if (discovered !== undefined && now() - discovered.at < discoveryMs) return discovered.value;
    if (discovery !== undefined) return discovery;
    if (now() < retryAfter) {
      throw new OidcError(
        "OIDC_DISCOVERY_FAILED",
        "Discovery failed a moment ago; not trying again yet.",
      );
    }
    discovery = discover(event)
      .then((value) => {
        discovered = { value, at: now() };
        return value;
      })
      .catch((error: unknown) => {
        retryAfter = now() + 5000;
        throw error;
      })
      .finally(() => {
        discovery = undefined;
      });
    return discovery;
  };

  // ---- the provider -------------------------------------------------------------------------------

  const formBody = (values: Record<string, string>): string =>
    new URLSearchParams(values).toString();

  const clientAuth = (values: Record<string, string>): Record<string, string> => {
    if (method === "client_secret_basic") {
      const encode = (value: string): string =>
        new URLSearchParams({ v: value }).toString().slice(2);
      return {
        authorization: `Basic ${btoa(`${encode(clientId)}:${encode(clientSecret as string)}`)}`,
      };
    }
    values["client_id"] = clientId;
    if (method === "client_secret_post") values["client_secret"] = clientSecret as string;
    return {};
  };

  const providerFailure = (
    code: OidcErrorCode,
    status: number,
    body: Record<string, unknown> | undefined,
    detail: string,
  ): OidcError => {
    const providerError = safeProviderError(body?.["error"]);
    const providerDescription = safeProviderDescription(body?.["error_description"]);
    return new OidcError(
      status >= 500 ? "OIDC_UPSTREAM_ERROR" : code,
      `${detail} (status ${status}${providerError === undefined ? "" : `, ${providerError}`}).`,
      {
        ...(providerError === undefined ? {} : { providerError }),
        ...(providerDescription === undefined ? {} : { providerDescription }),
      },
    );
  };

  const tokenRequest = async (
    event: RequestEvent,
    endpoint: URL,
    values: Record<string, string>,
    code: OidcErrorCode,
  ): Promise<Record<string, unknown>> => {
    const headers = { "content-type": "application/x-www-form-urlencoded", ...clientAuth(values) };
    const response = await fetchBounded(policyOf(event), endpoint, {
      method: "POST",
      headers,
      body: formBody(values),
    });
    const body = parseJsonObject(response.text);
    if (!response.ok || body === undefined || typeof body["error"] === "string") {
      throw providerFailure(code, response.status, body, "The token endpoint refused the request");
    }
    return body;
  };

  const toTokens = (body: Record<string, unknown>, previous?: StoredTokens): StoredTokens => {
    const accessToken = text(body["access_token"]);
    const type = body["token_type"];
    if (accessToken === undefined || typeof type !== "string" || type.toLowerCase() !== "bearer") {
      throw new OidcError("OIDC_TOKEN_ERROR", "The token response has no bearer access token.");
    }
    const lifetime = Number(body["expires_in"]);
    const refreshToken = text(body["refresh_token"]) ?? previous?.refreshToken;
    const idToken = text(body["id_token"]);
    const scope = text(body["scope"]);
    return {
      accessToken,
      ...(body["expires_in"] !== undefined && Number.isFinite(lifetime) && lifetime > 0
        ? { expiresAt: now() + lifetime * 1000 }
        : {}),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(idToken === undefined ? {} : { idToken }),
      ...(scope === undefined ? {} : { scope }),
    };
  };

  // ---- ID token validation ---------------------------------------------------------------------------

  const keyFor =
    (event: RequestEvent, resolved: Resolved) => async (header: { alg: string; kid?: string }) => {
      if (isHmacAlgorithm(header.alg)) {
        let key = hmacKeys.get(header.alg);
        if (key === undefined) {
          key = importHmacKey(clientSecret as string, header.alg);
          hmacKeys.set(header.alg, key);
        }
        return key;
      }
      if (resolved.jwks === undefined)
        throw new OidcError("OIDC_UNSUPPORTED", "No key set is configured.");
      jwks.cache ??= createJwksCache({
        uri: resolved.jwks.href,
        ttlSeconds: options.jwksSeconds ?? 600,
        now,
      });
      return jwks.cache.key(header, policyOf(event));
    };

  const invalidToken = (detail: string): OidcError =>
    new OidcError("OIDC_ID_TOKEN_INVALID", detail);

  const validateIdToken = async (
    event: RequestEvent,
    resolved: Resolved,
    idToken: string,
    expect: {
      readonly nonce: string | undefined;
      readonly accessToken: string | undefined;
      readonly sub: string | undefined;
    },
  ): Promise<Readonly<Record<string, unknown>>> => {
    const accepted = algorithms.filter(
      (alg) => resolved.algorithms === undefined || resolved.algorithms.includes(alg),
    );
    const { header, payload: claims } = await verifyJwt(idToken, {
      algorithms: accepted,
      key: keyFor(event, resolved),
    });
    const issuer = claims["iss"];
    const issuerOk =
      typeof issuer === "string" &&
      (options.issuerMatches !== undefined
        ? options.issuerMatches(issuer)
        : issuer === options.issuer);
    if (!issuerOk) throw invalidToken("The issuer of the ID token is not the expected one.");
    const audience = claims["aud"];
    const audiences = typeof audience === "string" ? [audience] : audience;
    if (
      !Array.isArray(audiences) ||
      audiences.length === 0 ||
      !audiences.every((a) => typeof a === "string")
    ) {
      throw invalidToken("The audience of the ID token is missing or malformed.");
    }
    if (!audiences.includes(clientId))
      throw invalidToken("The ID token was not issued for this client.");
    const authorizedParty = claims["azp"];
    if (authorizedParty !== undefined && authorizedParty !== clientId) {
      throw invalidToken("The authorized party of the ID token is another client.");
    }
    if (audiences.length > 1 && authorizedParty === undefined) {
      throw invalidToken("An ID token for several audiences must name the authorized party.");
    }
    const seconds = Math.floor(now() / 1000);
    const exp = claims["exp"];
    const iat = claims["iat"];
    const nbf = claims["nbf"];
    if (typeof exp !== "number" || !Number.isFinite(exp))
      throw invalidToken("The ID token has no expiry.");
    if (exp + skew <= seconds) throw invalidToken("The ID token has expired.");
    if (typeof iat !== "number" || !Number.isFinite(iat))
      throw invalidToken("The ID token has no issue time.");
    if (iat - skew > seconds) throw invalidToken("The ID token was issued in the future.");
    if (
      nbf !== undefined &&
      (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf - skew > seconds)
    ) {
      throw invalidToken("The ID token is not valid yet.");
    }
    const sub = claims["sub"];
    if (typeof sub !== "string" || sub === "" || sub.length > 255)
      throw invalidToken("The ID token has no usable subject.");
    if (expect.sub !== undefined && sub !== expect.sub)
      throw invalidToken("The ID token is for another user.");
    if (expect.nonce !== undefined) {
      const nonce = claims["nonce"];
      if (typeof nonce !== "string" || !timingSafeEqual(nonce, expect.nonce)) {
        throw invalidToken("The nonce of the ID token does not match the sign-in.");
      }
    }
    const atHash = claims["at_hash"];
    if (atHash !== undefined && expect.accessToken !== undefined) {
      const digest = new Uint8Array(
        await crypto.subtle.digest(hashOf(header.alg), utf8(expect.accessToken)),
      );
      const half = base64UrlEncode(digest.subarray(0, digest.length / 2));
      if (typeof atHash !== "string" || !timingSafeEqual(atHash, half)) {
        throw invalidToken("The access token does not match the at_hash of the ID token.");
      }
    }
    return claims;
  };

  const readUserinfo = async (
    event: RequestEvent,
    resolved: Resolved,
    accessToken: string,
  ): Promise<Readonly<Record<string, unknown>>> => {
    if (resolved.userinfo === undefined) {
      throw new OidcError("OIDC_UNSUPPORTED", "The provider has no userinfo endpoint.");
    }
    const response = await fetchBounded(policyOf(event), resolved.userinfo, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = response.ok ? parseJsonObject(response.text) : undefined;
    if (body === undefined) {
      throw new OidcError(
        "OIDC_USERINFO_INVALID",
        `The userinfo endpoint answered ${response.status} without a profile.`,
      );
    }
    const mapped = options.mapUserinfo === undefined ? body : options.mapUserinfo(body);
    if (!isRecord(mapped))
      throw new OidcError(
        "OIDC_USERINFO_INVALID",
        "The userinfo mapping did not return an object.",
      );
    return mapped;
  };

  // ---- session ----------------------------------------------------------------------------------------

  const readTransactions = (session: Session): Transaction[] => {
    const stored = session.get<unknown>(txKey);
    return Array.isArray(stored) ? (stored as Transaction[]) : [];
  };

  const cleanReturnTo = (event: RequestEvent, target: string | undefined): string => {
    if (target === undefined || target === "" || target.length > MAX_RETURN_TO) return "/";
    const checked = checkRedirectTarget(target, {
      origin: event.url.origin,
      trustedOrigins: new Set(),
    });
    if (checked instanceof RedirectBlockedError) return "/";
    const resolved = new URL(checked, event.url);
    if (resolved.origin !== event.url.origin) return "/";
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return path.startsWith("//") ? "/" : path;
  };

  const sanitizeLogoutTarget = (event: RequestEvent, target: string): string => {
    const checked = checkRedirectTarget(target, {
      origin: event.url.origin,
      trustedOrigins: new Set(),
    });
    if (checked instanceof RedirectBlockedError)
      throw new TypeError("postLogoutRedirectUri must be a path or a URL of this site.");
    return new URL(checked, event.url).href;
  };

  const storedTokens = (session: Session): StoredTokens | undefined => {
    const stored = session.get<unknown>(tokensKey);
    return isRecord(stored) && typeof stored["accessToken"] === "string"
      ? (stored as unknown as StoredTokens)
      : undefined;
  };

  const requireHttpsRedirect = (event: RequestEvent): void => {
    if (redirect.protocol === "http:" && !event.dev) {
      throw new OidcError("OIDC_INSECURE_URL", "The redirect URI uses http outside development.");
    }
  };

  const client: OidcClient = {
    sessionKey: userKey,

    async authorize(event, authorizeOptions = {}) {
      requireHttpsRedirect(event);
      const resolved = await endpointsOf(event);
      const session = await sessions.get(event);
      const state = randomToken(32);
      const nonce = oauth2 ? undefined : randomToken(32);
      const verifier = randomToken(48);
      const challenge = base64UrlEncode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))),
      );
      const time = now();
      const live = readTransactions(session).filter((entry) => entry.e > time);
      const transaction: Transaction = {
        s: state,
        n: nonce,
        v: verifier,
        r: cleanReturnTo(event, authorizeOptions.returnTo),
        e: time + transactionMs,
      };
      session.set(txKey, [...live, transaction].slice(-MAX_TRANSACTIONS));
      const url = new URL(resolved.authorization.href);
      const query = url.searchParams;
      query.set("response_type", "code");
      query.set("client_id", clientId);
      query.set("redirect_uri", options.redirectUri);
      const requested = authorizeOptions.scopes ?? scopes;
      if (requested.length > 0) query.set("scope", requested.join(" "));
      query.set("state", state);
      if (nonce !== undefined) query.set("nonce", nonce);
      query.set("code_challenge", challenge);
      query.set("code_challenge_method", "S256");
      for (const [key, value] of Object.entries({
        ...options.authorizationParams,
        ...authorizeOptions.params,
      })) {
        if (RESERVED_PARAMS.has(key))
          throw new TypeError(`authorize(): ${key} is a protocol parameter and cannot be set.`);
        query.set(key, value);
      }
      return redirectResponse(url.href);
    },

    async callback(event) {
      if (event.method !== "GET")
        throw new HttpError(405, "The sign-in callback answers GET only.");
      const query = event.url.searchParams;
      for (const key of ["state", "code", "iss", "error"]) {
        if (query.getAll(key).length > 1)
          throw new OidcError("OIDC_STATE_INVALID", `The callback repeats ${key}.`);
      }
      const state = query.get("state");
      if (state === null || state === "" || state.length > 512) {
        throw new OidcError("OIDC_STATE_MISSING", "The callback carries no state.");
      }
      const session = await sessions.get(event);
      // The transaction is removed whatever happens next: a callback URL works once.
      const transactions = readTransactions(session);
      let transaction: Transaction | undefined;
      const rest: Transaction[] = [];
      for (const entry of transactions) {
        const same = timingSafeEqual(entry.s, state);
        if (same && transaction === undefined) transaction = entry;
        else rest.push(entry);
      }
      if (transactions.length > 0) session.set(txKey, rest);
      if (transaction === undefined)
        throw new OidcError("OIDC_STATE_INVALID", "No sign-in is waiting for this state.");
      if (transaction.e <= now())
        throw new OidcError("OIDC_STATE_EXPIRED", "The sign-in took too long.");

      const resolved = await endpointsOf(event);
      const iss = query.get("iss");
      if (iss !== null) {
        const same =
          options.issuerMatches !== undefined ? options.issuerMatches(iss) : iss === options.issuer;
        if (!same)
          throw new OidcError("OIDC_ISSUER_MISMATCH", "The callback comes from another issuer.");
      } else if (options.requireIssParameter ?? resolved.issParameter) {
        throw new OidcError("OIDC_ISSUER_MISMATCH", "The callback lacks the iss parameter.");
      }
      const failure = query.get("error");
      if (failure !== null) {
        const providerError = safeProviderError(failure);
        const providerDescription = safeProviderDescription(query.get("error_description"));
        throw new OidcError(
          "OIDC_AUTHORIZATION_ERROR",
          `The provider refused the sign-in${providerError === undefined ? "" : ` (${providerError})`}.`,
          {
            ...(providerError === undefined ? {} : { providerError }),
            ...(providerDescription === undefined ? {} : { providerDescription }),
          },
        );
      }
      const code = query.get("code");
      if (code === null || code === "" || code.length > 2048) {
        throw new OidcError("OIDC_STATE_INVALID", "The callback carries no authorization code.");
      }

      const body = await tokenRequest(
        event,
        resolved.token,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: options.redirectUri,
          code_verifier: transaction.v,
        },
        "OIDC_TOKEN_ERROR",
      );
      const tokens = toTokens(body);
      let claims: Readonly<Record<string, unknown>> | undefined;
      if (!oauth2) {
        if (tokens.idToken === undefined) throw invalidToken("The token response has no ID token.");
        claims = await validateIdToken(event, resolved, tokens.idToken, {
          nonce: transaction.n,
          accessToken: tokens.accessToken,
          sub: undefined,
        });
      }
      const userinfo =
        oauth2 || options.fetchUserinfo === true
          ? await readUserinfo(event, resolved, tokens.accessToken)
          : undefined;
      const sub = text(claims?.["sub"]) ?? text(userinfo?.["sub"]);
      if (sub === undefined)
        throw new OidcError("OIDC_USERINFO_INVALID", "The provider did not say who signed in.");
      if (claims !== undefined && userinfo !== undefined && userinfo["sub"] !== claims["sub"]) {
        throw new OidcError("OIDC_USERINFO_INVALID", "The userinfo answer is for another user.");
      }
      const issuerName =
        typeof claims?.["iss"] === "string" ? claims["iss"] : (options.issuer ?? name);
      return {
        tokens,
        claims,
        userinfo,
        user: toUser(issuerName, { ...claims, ...userinfo }, sub),
        returnTo: cleanReturnTo(event, transaction.r),
      };
    },

    async signIn(event, result) {
      const session = await sessions.get(event);
      signIn(session, {
        [userKey]: result.user,
        ...(storeTokens ? { [tokensKey]: result.tokens } : {}),
      });
    },

    async handleCallback(event) {
      const result = await client.callback(event);
      await client.signIn(event, result);
      return redirectResponse(result.returnTo, 303);
    },

    async user(event) {
      const stored = (await sessions.get(event)).get<unknown>(userKey);
      return isRecord(stored) &&
        typeof stored["id"] === "string" &&
        typeof stored["issuer"] === "string"
        ? (stored as unknown as OidcUser)
        : undefined;
    },

    async refresh(event) {
      const session = await sessions.get(event);
      const current = storedTokens(session);
      const refreshToken = current?.refreshToken;
      if (current === undefined || refreshToken === undefined) {
        throw new OidcError("OIDC_NOT_SIGNED_IN", "There is no refresh token in this session.");
      }
      const time = now();
      for (const [key, entry] of recentRefresh) if (entry.until <= time) recentRefresh.delete(key);
      let shared = recentRefresh.get(refreshToken);
      if (shared === undefined) {
        const resolvedPromise = (async (): Promise<StoredTokens> => {
          const resolved = await endpointsOf(event);
          const body = await tokenRequest(
            event,
            resolved.token,
            { grant_type: "refresh_token", refresh_token: refreshToken },
            "OIDC_REFRESH_FAILED",
          );
          const next = toTokens(body, current);
          if (next.idToken !== undefined && !oauth2) {
            const user = await client.user(event);
            await validateIdToken(event, resolved, next.idToken, {
              nonce: undefined,
              accessToken: next.accessToken,
              sub: user?.id,
            });
          }
          const idToken = next.idToken ?? current.idToken;
          return idToken === undefined ? next : { ...next, idToken };
        })();
        shared = { promise: resolvedPromise, until: time + REFRESH_REUSE_MS };
        recentRefresh.set(refreshToken, shared);
        resolvedPromise.catch(() => {
          recentRefresh.delete(refreshToken);
        });
        if (recentRefresh.size > 1000) {
          const oldest = recentRefresh.keys().next();
          if (oldest.done !== true) recentRefresh.delete(oldest.value);
        }
      }
      try {
        const next = await shared.promise;
        if (storeTokens) session.set(tokensKey, next);
        return next;
      } catch (error) {
        if (
          isOidcError(error) &&
          error.code === "OIDC_REFRESH_FAILED" &&
          error.providerError === "invalid_grant"
        ) {
          // The provider revoked the grant: the stored tokens are useless now.
          session.delete(tokensKey);
        }
        throw error;
      }
    },

    async accessToken(event, tokenOptions = {}) {
      const session = await sessions.get(event);
      const current = storedTokens(session);
      if (current === undefined) return undefined;
      const leeway = (tokenOptions.leewaySeconds ?? 30) * 1000;
      if (current.expiresAt === undefined || current.expiresAt - leeway > now())
        return current.accessToken;
      if (current.refreshToken === undefined) return undefined;
      return (await client.refresh(event)).accessToken;
    },

    async userinfo(event) {
      const token = await client.accessToken(event);
      const user = await client.user(event);
      if (token === undefined || user === undefined)
        throw new OidcError("OIDC_NOT_SIGNED_IN", "Nobody is signed in.");
      const info = await readUserinfo(event, await endpointsOf(event), token);
      if (info["sub"] !== user.id)
        throw new OidcError("OIDC_USERINFO_INVALID", "The userinfo answer is for another user.");
      return info;
    },

    async logoutUrl(event, logoutOptions = {}) {
      const resolved = await endpointsOf(event);
      if (resolved.endSession === undefined) return undefined;
      const url = new URL(resolved.endSession.href);
      const tokens = storedTokens(await sessions.get(event));
      if (tokens?.idToken !== undefined) url.searchParams.set("id_token_hint", tokens.idToken);
      url.searchParams.set("client_id", clientId);
      if (logoutOptions.postLogoutRedirectUri !== undefined) {
        url.searchParams.set(
          "post_logout_redirect_uri",
          sanitizeLogoutTarget(event, logoutOptions.postLogoutRedirectUri),
        );
      }
      if (logoutOptions.state !== undefined) url.searchParams.set("state", logoutOptions.state);
      return url.href;
    },

    async signOut(event, logoutOptions = {}) {
      const session = await sessions.get(event);
      const resolved = await endpointsOf(event);
      const tokens = storedTokens(session);
      const target = await client.logoutUrl(event, logoutOptions);
      if (
        logoutOptions.revoke !== false &&
        resolved.revocation !== undefined &&
        tokens?.refreshToken !== undefined
      ) {
        const values: Record<string, string> = {
          token: tokens.refreshToken,
          token_type_hint: "refresh_token",
        };
        try {
          await fetchBounded(policyOf(event), resolved.revocation, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", ...clientAuth(values) },
            body: formBody(values),
          });
        } catch {
          // Best effort: the session ends whatever the provider answers, and the refresh token expires on its own.
        }
      }
      session.destroy();
      const local =
        logoutOptions.postLogoutRedirectUri === undefined
          ? "/"
          : cleanReturnTo(event, logoutOptions.postLogoutRedirectUri);
      return redirectResponse(target ?? local, 303);
    },
  };
  return client;
}
