import { describe, expect, it } from "vitest";
import { createOidcClient, type OidcClientOptions } from "../../src/auth/index";
import { timingSafeEqual } from "../../src/auth/oidc";
import { createSessionManager } from "../../src/server/index";

const sessions = createSessionManager({ secrets: ["0123456789abcdef0123456789abcdef"] });
const base: OidcClientOptions = {
  issuer: "https://issuer.example",
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://app.example/auth/callback",
  sessions,
};
const make = (extra: Partial<OidcClientOptions>) => () => createOidcClient({ ...base, ...extra });

describe("client configuration is strict", () => {
  it("[DUSK-AUTH-CONFIG-01] accepts a sound configuration, and localhost over http", () => {
    expect(make({})).not.toThrow();
    expect(
      make({ issuer: "http://localhost:8080", redirectUri: "http://localhost:3000/cb" }),
    ).not.toThrow();
    expect(
      make({ issuer: "http://127.0.0.1:8080/realms/x", redirectUri: "http://[::1]:3000/cb" }),
    ).not.toThrow();
    expect(make({ clientSecret: undefined as never })).not.toThrow();
  });

  it.each<[string, Partial<OidcClientOptions>]>([
    ["no issuer and no endpoints", { issuer: undefined as never }],
    ["an http issuer on a real host", { issuer: "http://issuer.example" }],
    ["an issuer that only looks like localhost", { issuer: "http://localhost.evil.example" }],
    ["an issuer with a query", { issuer: "https://issuer.example/?x=1" }],
    ["an issuer that is not a URL", { issuer: "issuer.example" }],
    ["an http redirect URI on a real host", { redirectUri: "http://app.example/cb" }],
    ["a redirect URI with a fragment", { redirectUri: "https://app.example/cb#x" }],
    ["a redirect URI that is not a URL", { redirectUri: "/cb" }],
    ["no client id", { clientId: "" }],
    ["an empty secret", { clientSecret: "" }],
    ["scopes without openid", { scopes: ["profile"] }],
    [
      "HS256 for a public client",
      { clientSecret: undefined as never, idTokenAlgorithms: ["HS256"] },
    ],
    ["an algorithm that is not supported", { idTokenAlgorithms: ["none" as never] }],
    [
      "a basic method without a secret",
      { clientSecret: undefined as never, tokenEndpointAuthMethod: "client_secret_basic" },
    ],
    ["a reserved authorization parameter", { authorizationParams: { state: "fixed" } }],
    ["a negative timeout", { timeoutMs: -1 }],
    [
      "endpoints without a key set for OpenID Connect",
      {
        issuer: "https://issuer.example",
        endpoints: { authorization: "https://i.example/a", token: "https://i.example/t" },
      },
    ],
    [
      "OpenID Connect endpoints with nothing to compare iss with",
      {
        issuer: undefined as never,
        endpoints: {
          authorization: "https://i.example/a",
          token: "https://i.example/t",
          jwks: "https://i.example/k",
        },
      },
    ],
  ])("[DUSK-AUTH-CONFIG-02] refuses %s", (_name, extra) => {
    expect(make(extra)).toThrow(TypeError);
  });

  it("[DUSK-AUTH-CONFIG-03] plain OAuth 2.0 needs no issuer and no jwks", () => {
    expect(
      make({
        oauth2: true,
        issuer: undefined as never,
        scopes: [],
        endpoints: {
          authorization: "https://p.example/a",
          token: "https://p.example/t",
          userinfo: "https://p.example/u",
        },
      }),
    ).not.toThrow();
  });

  it("[DUSK-AUTH-CONFIG-04] timingSafeEqual compares whole strings, whatever their lengths", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("é", "é")).toBe(false);
  });
});
