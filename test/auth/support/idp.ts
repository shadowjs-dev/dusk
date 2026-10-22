import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real identity provider on `node:http`: discovery, `/authorize`, `/token`, `/jwks`, `/userinfo`, `/end_session`, with
 * genuine RS256 / PS256 / ES256 / EdDSA signatures made by WebCrypto. Nothing in it is mocked: the client under test talks
 * to it over a socket and has to verify what it gets.
 */

export type IdpAlgorithm = "RS256" | "PS256" | "ES256" | "EdDSA";

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const json = (value: unknown): string => JSON.stringify(value);

interface SigningKey {
  readonly kid: string;
  readonly alg: IdpAlgorithm;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey & { kid: string; alg: string; use: string };
}

const generateParams = {
  RS256: {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  PS256: {
    name: "RSA-PSS",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  EdDSA: { name: "Ed25519" },
} as const;

const signParams = {
  RS256: { name: "RSASSA-PKCS1-v1_5" },
  PS256: { name: "RSA-PSS", saltLength: 32 },
  ES256: { name: "ECDSA", hash: "SHA-256" },
  EdDSA: { name: "Ed25519" },
} as const;

let keyCounter = 0;

/** Generates a fresh signing key. RSA generation is slow, so suites reuse keys through `keyPool`. */
export async function generateSigningKey(alg: IdpAlgorithm): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(generateParams[alg], true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  keyCounter += 1;
  const kid = `${alg.toLowerCase()}-${keyCounter}`;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    publicJwk: { ...exported, kid, alg, use: "sig", key_ops: undefined, ext: undefined } as never,
  };
}

const pool = new Map<IdpAlgorithm, Promise<SigningKey>>();
/** One cached key per algorithm for the whole test file (RSA generation takes a while). */
export function keyPool(alg: IdpAlgorithm): Promise<SigningKey> {
  let existing = pool.get(alg);
  if (existing === undefined) {
    existing = generateSigningKey(alg);
    pool.set(alg, existing);
  }
  return existing;
}

/** Signs a JWT the way an IdP does. `header` overrides are merged over `{ alg, kid, typ }`. */
export async function signJwt(
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = b64u(Buffer.from(json({ alg: key.alg, kid: key.kid, typ: "JWT", ...header })));
  const body = b64u(Buffer.from(json(claims)));
  const input = `${head}.${body}`;
  const signature = await crypto.subtle.sign(
    signParams[key.alg],
    key.privateKey,
    Buffer.from(input),
  );
  return `${input}.${b64u(new Uint8Array(signature))}`;
}

export interface IdpUser {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

export interface IdpHooks {
  /** Edit the ID token claims before signing. */
  claims?: (claims: Record<string, unknown>) => Record<string, unknown>;
  /** Extra header fields (for example `{ kid: "other" }`). */
  header?: Record<string, unknown>;
  /** Sign with this key instead of the current one. */
  signWith?: SigningKey;
  /** Rewrite the token response body. */
  tokenResponse?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** The `iss` response parameter on the authorization response: `true` the issuer, a string, or `false` for none. */
  iss?: boolean | string;
  /** Wait this long before answering the token endpoint. */
  tokenDelayMs?: number;
  /** Answer the token endpoint with this many bytes of garbage. */
  tokenBytes?: number;
  /** Replace the `sub` of the userinfo answer. */
  userinfoSub?: string;
  /** Answer the JWKS endpoint with this status. */
  jwksStatus?: number;
  /** Do not include the ID token. */
  omitIdToken?: boolean;
  /** Redirect the token endpoint to this URL. */
  tokenRedirect?: string;
  /** Make the discovery document claim another issuer. */
  discoveryIssuer?: string;
  /** Lifetime of access tokens in seconds. */
  expiresIn?: number;
}

export interface Idp {
  readonly issuer: string;
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly hooks: IdpHooks;
  readonly user: IdpUser;
  readonly stats: {
    discovery: number;
    jwks: number;
    token: number;
    userinfo: number;
    endSession: URLSearchParams[];
    tokenRequests: Array<{ params: URLSearchParams; authorization: string | undefined }>;
    authorizeRequests: URLSearchParams[];
    refreshTokensIssued: number;
  };
  readonly key: SigningKey;
  /** Replaces the signing key with a new one. The old key stays in the JWKS only when `keepOld`. */
  rotateKey(options?: { keepOld?: boolean }): Promise<SigningKey>;
  signIdToken(
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
    key?: SigningKey,
  ): Promise<string>;
  /** Claims of a valid ID token for `nonce`, as the IdP would issue them now. */
  idClaims(nonce: string | undefined, extra?: Record<string, unknown>): Record<string, unknown>;
  /** The browser step: opens the authorization URL and returns the URL the IdP redirected to. */
  approve(authorizationUrl: string): Promise<URL>;
  /** Revokes every refresh token (the account was disabled). */
  revokeAllRefreshTokens(): void;
  close(): Promise<void>;
}

export interface IdpOptions {
  alg?: IdpAlgorithm;
  clientId?: string;
  clientSecret?: string | undefined;
  redirectUris?: readonly string[];
  /** Path under the origin, for issuers like a Keycloak realm. */
  issuerPath?: string;
  scopesSupported?: readonly string[];
  hmacSecret?: string;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const send = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(typeof body === "string" ? body : json(body));
};

export async function startIdp(options: IdpOptions = {}): Promise<Idp> {
  const alg = options.alg ?? "RS256";
  const clientId = options.clientId ?? "client-1";
  const clientSecret = "clientSecret" in options ? options.clientSecret : "s3cret-s3cret-s3cret";
  const redirectUris = options.redirectUris ?? ["https://app.test/auth/callback"];
  const issuerPath = options.issuerPath ?? "";
  let signing = await keyPool(alg);
  let keys: SigningKey[] = [signing];
  const hooks: IdpHooks = {};
  const user: IdpUser = {
    sub: "user-123",
    name: "Ada Lovelace",
    email: "ada@example.test",
    email_verified: true,
    picture: "https://img.example.test/ada.png",
  };
  const stats: Idp["stats"] = {
    discovery: 0,
    jwks: 0,
    token: 0,
    userinfo: 0,
    endSession: [],
    tokenRequests: [],
    authorizeRequests: [],
    refreshTokensIssued: 0,
  };
  const codes = new Map<
    string,
    { nonce: string | undefined; challenge: string; redirectUri: string; scope: string }
  >();
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Map<string, { scope: string }>();
  let origin = "";
  const issuer = (): string => `${origin}${issuerPath}`;

  const idClaims: Idp["idClaims"] = (nonce, extra = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: issuer(),
      sub: user.sub,
      aud: clientId,
      exp: now + 300,
      iat: now,
      auth_time: now,
      ...(nonce === undefined ? {} : { nonce }),
      name: user.name,
      email: user.email,
      email_verified: user.email_verified,
      picture: user.picture,
      ...extra,
    };
  };

  const issueTokens = async (
    scope: string,
    nonce: string | undefined,
    withRefresh: boolean,
  ): Promise<Record<string, unknown>> => {
    const accessToken = `at-${randomBytes(16).toString("hex")}`;
    const expiresIn = hooks.expiresIn ?? 3600;
    accessTokens.set(accessToken, Date.now() + expiresIn * 1000);
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope,
    };
    if (withRefresh) {
      const refresh = `rt-${randomBytes(16).toString("hex")}`;
      refreshTokens.set(refresh, { scope });
      stats.refreshTokensIssued += 1;
      body["refresh_token"] = refresh;
    }
    if (scope.split(" ").includes("openid") && hooks.omitIdToken !== true) {
      // OpenID Connect Core 3.1.3.6: the hash follows the algorithm; Ed25519 uses SHA-512.
      const hashName = alg === "EdDSA" ? "sha512" : "sha256";
      const digest = createHash(hashName).update(accessToken).digest();
      const atHash = b64u(digest.subarray(0, digest.length / 2));
      const claims = hooks.claims?.({ ...idClaims(nonce), at_hash: atHash }) ?? {
        ...idClaims(nonce),
        at_hash: atHash,
      };
      body["id_token"] = await signJwt(hooks.signWith ?? signing, claims, hooks.header);
    }
    return hooks.tokenResponse?.(body) ?? body;
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const path = url.pathname.slice(issuerPath.length);
    try {
      if (url.pathname.startsWith(issuerPath) && path === "/.well-known/openid-configuration") {
        stats.discovery += 1;
        send(response, 200, {
          issuer: hooks.discoveryIssuer ?? issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          jwks_uri: `${issuer()}/jwks`,
          userinfo_endpoint: `${issuer()}/userinfo`,
          end_session_endpoint: `${issuer()}/end_session`,
          revocation_endpoint: `${issuer()}/revoke`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: [alg],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: options.scopesSupported ?? ["openid", "profile", "email"],
        });
        return;
      }
      if (path === "/jwks") {
        stats.jwks += 1;
        if (hooks.jwksStatus !== undefined) {
          send(response, hooks.jwksStatus, { error: "down" });
          return;
        }
        send(response, 200, { keys: keys.map((k) => k.publicJwk) });
        return;
      }
      if (path === "/authorize") {
        stats.authorizeRequests.push(url.searchParams);
        const q = url.searchParams;
        const redirectUri = q.get("redirect_uri") ?? "";
        if (q.get("client_id") !== clientId || !redirectUris.includes(redirectUri)) {
          send(response, 400, { error: "invalid_request" });
          return;
        }
        const target = new URL(redirectUri);
        const state = q.get("state");
        if (state !== null) target.searchParams.set("state", state);
        if (
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          (q.get("code_challenge") ?? "") === ""
        ) {
          target.searchParams.set("error", "invalid_request");
          target.searchParams.set("error_description", "PKCE with S256 is required");
        } else {
          const code = `code-${randomBytes(16).toString("hex")}`;
          codes.set(code, {
            nonce: q.get("nonce") ?? undefined,
            challenge: q.get("code_challenge") ?? "",
            redirectUri,
            scope: q.get("scope") ?? "",
          });
          target.searchParams.set("code", code);
        }
        const iss = hooks.iss ?? true;
        if (iss !== false) target.searchParams.set("iss", iss === true ? issuer() : iss);
        response.writeHead(302, { location: target.href });
        response.end();
        return;
      }
      if (path === "/token") {
        stats.token += 1;
        const params = new URLSearchParams(await readBody(request));
        stats.tokenRequests.push({ params, authorization: request.headers.authorization });
        if (hooks.tokenRedirect !== undefined) {
          response.writeHead(302, { location: hooks.tokenRedirect });
          response.end();
          return;
        }
        if (hooks.tokenDelayMs !== undefined)
          await new Promise((resolve) => setTimeout(resolve, hooks.tokenDelayMs));
        if (hooks.tokenBytes !== undefined) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(`{"pad":"${"a".repeat(hooks.tokenBytes)}"}`);
          return;
        }
        // Client authentication.
        let presentedId = params.get("client_id");
        let presentedSecret = params.get("client_secret");
        const basic = request.headers.authorization;
        if (basic?.startsWith("Basic ") === true) {
          const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
          const colon = decoded.indexOf(":");
          presentedId = decodeURIComponent(decoded.slice(0, colon).replaceAll("+", "%20"));
          presentedSecret = decodeURIComponent(decoded.slice(colon + 1).replaceAll("+", "%20"));
        }
        if (
          presentedId !== clientId ||
          (clientSecret !== undefined && presentedSecret !== clientSecret)
        ) {
          send(response, 401, { error: "invalid_client" });
          return;
        }
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          const code = params.get("code") ?? "";
          const record = codes.get(code);
          codes.delete(code);
          if (record === undefined) {
            send(response, 400, { error: "invalid_grant", error_description: "unknown code" });
            return;
          }
          const verifier = params.get("code_verifier") ?? "";
          const challenge = b64u(createHash("sha256").update(verifier).digest());
          if (challenge !== record.challenge || params.get("redirect_uri") !== record.redirectUri) {
            send(response, 400, { error: "invalid_grant", error_description: "PKCE or redirect" });
            return;
          }
          send(response, 200, await issueTokens(record.scope, record.nonce, true), {
            "cache-control": "no-store",
          });
          return;
        }
        if (grant === "refresh_token") {
          const presented = params.get("refresh_token") ?? "";
          const record = refreshTokens.get(presented);
          refreshTokens.delete(presented);
          if (record === undefined) {
            send(response, 400, { error: "invalid_grant" });
            return;
          }
          send(response, 200, await issueTokens(record.scope, undefined, true));
          return;
        }
        send(response, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (path === "/userinfo") {
        stats.userinfo += 1;
        const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const expires = accessTokens.get(bearer);
        if (expires === undefined || expires < Date.now()) {
          send(response, 401, { error: "invalid_token" });
          return;
        }
        send(response, 200, { ...user, sub: hooks.userinfoSub ?? user.sub });
        return;
      }
      if (path === "/end_session") {
        stats.endSession.push(url.searchParams);
        send(response, 200, {});
        return;
      }
      if (path === "/revoke") {
        const params = new URLSearchParams(await readBody(request));
        refreshTokens.delete(params.get("token") ?? "");
        send(response, 200, {});
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) {
      send(response, 500, { error: String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    get issuer() {
      return issuer();
    },
    origin,
    clientId,
    clientSecret,
    hooks,
    user,
    stats,
    get key() {
      return signing;
    },
    async rotateKey(rotation = {}) {
      signing = await generateSigningKey(alg);
      keys = rotation.keepOld === true ? [...keys, signing] : [signing];
      return signing;
    },
    signIdToken: (claims, header, key) => signJwt(key ?? signing, claims, header),
    idClaims,
    async approve(authorizationUrl) {
      const answer = await fetch(authorizationUrl, { redirect: "manual" });
      const location = answer.headers.get("location");
      if (answer.status !== 302 || location === null)
        throw new Error(`authorize answered ${answer.status}`);
      return new URL(location);
    },
    revokeAllRefreshTokens() {
      refreshTokens.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
