import type { OidcClientOptions } from "./oidc";

/**
 * The provider-specific part of {@link OidcClientOptions}: spread it first, then add your registration.
 * @since 1.0.0
 */
export type OidcPreset = Pick<
  OidcClientOptions,
  | "name"
  | "issuer"
  | "endpoints"
  | "issuerMatches"
  | "scopes"
  | "oauth2"
  | "tokenEndpointAuthMethod"
  | "authorizationParams"
  | "mapUserinfo"
>;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function host(value: string, what: string): string {
  if (!HOST.test(value))
    throw new TypeError(`${what} must be a host name such as "example.auth0.com".`);
  return value;
}

function segment(value: string, what: string): string {
  if (!SEGMENT.test(value))
    throw new TypeError(`${what} may contain letters, digits and . _ ~ - only.`);
  return value;
}

/**
 * Google (OpenID Connect, discovery).
 *
 * @returns The preset.
 * @example
 * createOidcClient({ ...google(), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function google(): OidcPreset {
  return {
    name: "google",
    issuer: "https://accounts.google.com",
    scopes: ["openid", "email", "profile"],
  };
}

/** Options of {@link microsoft}. @since 1.0.0 */
export interface MicrosoftOptions {
  /**
   * The directory: its GUID (the issuer is then checked exactly), a verified domain, or `common`, `organizations`,
   * `consumers`. Anything but a GUID accepts tokens from several directories, and you must check the `tid` claim of the
   * user yourself.
   */
  readonly tenant: string;
}

/**
 * Microsoft Entra ID (OpenID Connect, v2.0 endpoints). With a tenant GUID the issuer is discovered and compared exactly;
 * with `common`, `organizations`, `consumers` or a domain the endpoints are fixed and the issuer must have the shape
 * `https://login.microsoftonline.com/<tenant GUID>/v2.0`.
 *
 * @param options The tenant.
 * @returns The preset.
 * @throws TypeError for a tenant with characters that could change the endpoint paths.
 * @example
 * createOidcClient({ ...microsoft({ tenant: "11111111-2222-3333-4444-555555555555" }), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function microsoft(options: MicrosoftOptions): OidcPreset {
  const tenant = segment(options.tenant, "tenant");
  const scopes = ["openid", "profile", "email", "offline_access"];
  if (GUID.test(tenant)) {
    return {
      name: "microsoft",
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      scopes,
    };
  }
  const base = `https://login.microsoftonline.com/${tenant}`;
  return {
    name: "microsoft",
    issuer: `${base}/v2.0`,
    endpoints: {
      authorization: `${base}/oauth2/v2.0/authorize`,
      token: `${base}/oauth2/v2.0/token`,
      jwks: `${base}/discovery/v2.0/keys`,
      userinfo: "https://graph.microsoft.com/oidc/userinfo",
      endSession: `${base}/oauth2/v2.0/logout`,
    },
    issuerMatches: (issuer) =>
      /^https:\/\/login\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/v2\.0$/i.test(
        issuer,
      ),
    scopes,
  };
}

/** Options of {@link auth0}. @since 1.0.0 */
export interface Auth0Options {
  /** Your tenant domain, for example `example.eu.auth0.com` or your custom domain. */
  readonly domain: string;
  /** The API identifier, to receive an access token for your API. */
  readonly audience?: string;
}

/**
 * Auth0 (OpenID Connect, discovery). The issuer of Auth0 ends with a slash.
 *
 * @param options Tenant domain and optional API audience.
 * @returns The preset.
 * @throws TypeError for a domain that is not a host name.
 * @example
 * createOidcClient({ ...auth0({ domain: "example.eu.auth0.com" }), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function auth0(options: Auth0Options): OidcPreset {
  return {
    name: "auth0",
    issuer: `https://${host(options.domain, "domain")}/`,
    scopes: ["openid", "profile", "email", "offline_access"],
    ...(options.audience === undefined
      ? {}
      : { authorizationParams: { audience: options.audience } }),
  };
}

/** Options of {@link okta}. @since 1.0.0 */
export interface OktaOptions {
  /** Your Okta domain, for example `example.okta.com`. */
  readonly domain: string;
  /** The authorization server. Default `"default"`; `null` selects the org authorization server. */
  readonly authorizationServer?: string | null;
}

/**
 * Okta (OpenID Connect, discovery) with the `default` custom authorization server unless told otherwise.
 *
 * @param options Domain and authorization server.
 * @returns The preset.
 * @throws TypeError for a domain or server id with unexpected characters.
 * @example
 * createOidcClient({ ...okta({ domain: "example.okta.com" }), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function okta(options: OktaOptions): OidcPreset {
  const server =
    options.authorizationServer === undefined ? "default" : options.authorizationServer;
  const base = `https://${host(options.domain, "domain")}`;
  return {
    name: "okta",
    issuer: server === null ? base : `${base}/oauth2/${segment(server, "authorizationServer")}`,
    scopes: ["openid", "profile", "email", "offline_access"],
  };
}

/** Options of {@link keycloak}. @since 1.0.0 */
export interface KeycloakOptions {
  /** Base URL of the server, for example `https://id.example.com` (add `/auth` for old servers). */
  readonly baseUrl: string;
  /** The realm. */
  readonly realm: string;
}

/**
 * Keycloak (OpenID Connect, discovery). The issuer is `<baseUrl>/realms/<realm>`.
 *
 * @param options Server and realm.
 * @returns The preset.
 * @throws TypeError for a base URL that is not an http(s) URL or a realm with unexpected characters.
 * @example
 * createOidcClient({ ...keycloak({ baseUrl: "https://id.example.com", realm: "main" }), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function keycloak(options: KeycloakOptions): OidcPreset {
  if (!URL.canParse(options.baseUrl)) throw new TypeError("baseUrl must be a URL.");
  const base = new URL(options.baseUrl);
  if (base.search !== "" || base.hash !== "")
    throw new TypeError("baseUrl must not have a query or a fragment.");
  return {
    name: "keycloak",
    issuer: `${base.origin}${base.pathname.replace(/\/$/, "")}/realms/${segment(options.realm, "realm")}`,
    scopes: ["openid", "profile", "email"],
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * GitHub (plain OAuth 2.0: GitHub issues no ID token, so the profile is read from `https://api.github.com/user`). The
 * public e-mail of that answer is not guaranteed to be verified; do not link accounts by it.
 *
 * @returns The preset.
 * @example
 * createOidcClient({ ...github(), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function github(): OidcPreset {
  return {
    name: "github",
    oauth2: true,
    endpoints: {
      authorization: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      userinfo: "https://api.github.com/user",
    },
    scopes: ["read:user", "user:email"],
    tokenEndpointAuthMethod: "client_secret_post",
    mapUserinfo: (raw) => {
      const id =
        typeof raw["id"] === "number" || typeof raw["id"] === "string"
          ? String(raw["id"])
          : undefined;
      const login = text(raw["login"]);
      return {
        ...(id === undefined ? {} : { sub: id }),
        ...(login === undefined ? {} : { preferred_username: login }),
        name: text(raw["name"]) ?? login,
        email: text(raw["email"]),
        picture: text(raw["avatar_url"]),
      };
    },
  };
}

/**
 * Discord (plain OAuth 2.0: the profile is read from `https://discord.com/api/users/@me`).
 *
 * @returns The preset.
 * @example
 * createOidcClient({ ...discord(), clientId, clientSecret, redirectUri, sessions });
 * @since 1.0.0
 */
export function discord(): OidcPreset {
  return {
    name: "discord",
    oauth2: true,
    endpoints: {
      authorization: "https://discord.com/oauth2/authorize",
      token: "https://discord.com/api/oauth2/token",
      userinfo: "https://discord.com/api/users/@me",
      revocation: "https://discord.com/api/oauth2/token/revoke",
    },
    scopes: ["identify", "email"],
    tokenEndpointAuthMethod: "client_secret_post",
    mapUserinfo: (raw) => {
      const id = text(raw["id"]);
      const avatar = text(raw["avatar"]);
      return {
        ...(id === undefined ? {} : { sub: id }),
        preferred_username: text(raw["username"]),
        name: text(raw["global_name"]) ?? text(raw["username"]),
        email: text(raw["email"]),
        email_verified: raw["verified"] === true,
        picture:
          id !== undefined && avatar !== undefined
            ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
            : undefined,
      };
    },
  };
}
