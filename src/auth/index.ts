/**
 * Provider-agnostic sign-in building blocks: the OAuth 2.1 / OpenID Connect authorization code flow with PKCE, ID token
 * verification with WebCrypto, provider presets and a guard. Import it from `@shadow-js/dusk/auth`.
 * @packageDocumentation
 */
export { isOidcError, OidcError, type OidcErrorCode, type OidcErrorOptions } from "./errors";
export { type RequireUserOptions, requireUser } from "./guard";
export { createJwksCache, type JwksCache, type JwksCacheOptions } from "./jwks";
export {
  importVerificationKey,
  type Jwk,
  type JwsAlgorithm,
  type JwtHeader,
  type VerifiedJwt,
  type VerifyJwtOptions,
  verifyJwt,
} from "./jwt";
export {
  createOidcClient,
  type OidcAuthorizeOptions,
  type OidcCallbackResult,
  type OidcClient,
  type OidcClientAuthMethod,
  type OidcClientOptions,
  type OidcEndpoints,
  type OidcLogoutOptions,
  type OidcTokens,
  type OidcUser,
} from "./oidc";
export {
  type Auth0Options,
  auth0,
  discord,
  github,
  google,
  type KeycloakOptions,
  keycloak,
  type MicrosoftOptions,
  microsoft,
  type OidcPreset,
  type OktaOptions,
  okta,
} from "./presets";
