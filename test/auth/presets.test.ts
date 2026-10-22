import { describe, expect, it } from "vitest";
import {
  auth0,
  createOidcClient,
  discord,
  github,
  google,
  keycloak,
  microsoft,
  okta,
} from "../../src/auth/index";
import { createMemorySessionStore, createSessionManager } from "../../src/server/index";

const sessions = createSessionManager({
  secrets: ["0123456789abcdef0123456789abcdef"],
  store: createMemorySessionStore(),
});
const registration = {
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://app.example/auth/callback",
  sessions,
};

describe("provider presets (shape only, no network)", () => {
  it("[DUSK-AUTH-PRESET-01] google", () => {
    const preset = google();
    expect(preset).toMatchObject({ name: "google", issuer: "https://accounts.google.com" });
    expect(preset.scopes).toContain("openid");
    expect(() => createOidcClient({ ...preset, ...registration })).not.toThrow();
  });

  it("[DUSK-AUTH-PRESET-02] microsoft: a tenant GUID is discovered and compared exactly, anything else is pattern checked", () => {
    const guid = "11111111-2222-3333-4444-555555555555";
    expect(microsoft({ tenant: guid })).toMatchObject({
      issuer: `https://login.microsoftonline.com/${guid}/v2.0`,
    });
    expect(microsoft({ tenant: guid }).endpoints).toBeUndefined();
    const common = microsoft({ tenant: "common" });
    expect(common.endpoints?.authorization).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(common.endpoints?.jwks).toBe(
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    );
    expect(common.issuerMatches?.(`https://login.microsoftonline.com/${guid}/v2.0`)).toBe(true);
    for (const issuer of [
      "https://login.microsoftonline.com/common/v2.0",
      `https://evil.example/${guid}/v2.0`,
      `https://login.microsoftonline.com.evil.example/${guid}/v2.0`,
      `https://login.microsoftonline.com/${guid}/v2.0/extra`,
      `http://login.microsoftonline.com/${guid}/v2.0`,
    ]) {
      expect(common.issuerMatches?.(issuer), issuer).toBe(false);
    }
    expect(() => microsoft({ tenant: "a/../b" })).toThrow(TypeError);
    expect(() => microsoft({ tenant: "contoso.onmicrosoft.com?x=1" })).toThrow(TypeError);
    expect(() => createOidcClient({ ...common, ...registration })).not.toThrow();
    expect(() =>
      createOidcClient({ ...microsoft({ tenant: guid }), ...registration }),
    ).not.toThrow();
  });

  it("[DUSK-AUTH-PRESET-03] auth0 keeps the trailing slash of its issuer and can carry an audience", () => {
    const preset = auth0({ domain: "example.eu.auth0.com", audience: "https://api.example" });
    expect(preset.issuer).toBe("https://example.eu.auth0.com/");
    expect(preset.authorizationParams).toEqual({ audience: "https://api.example" });
    expect(auth0({ domain: "example.eu.auth0.com" }).authorizationParams).toBeUndefined();
    expect(() => auth0({ domain: "evil.test/path" })).toThrow(TypeError);
    expect(() => auth0({ domain: "user@evil.test" })).toThrow(TypeError);
    expect(() => createOidcClient({ ...preset, ...registration })).not.toThrow();
  });

  it("[DUSK-AUTH-PRESET-04] okta: default, custom and org authorization servers", () => {
    expect(okta({ domain: "example.okta.com" }).issuer).toBe(
      "https://example.okta.com/oauth2/default",
    );
    expect(okta({ domain: "example.okta.com", authorizationServer: "aus1" }).issuer).toBe(
      "https://example.okta.com/oauth2/aus1",
    );
    expect(okta({ domain: "example.okta.com", authorizationServer: null }).issuer).toBe(
      "https://example.okta.com",
    );
    expect(() => okta({ domain: "example.okta.com", authorizationServer: "../x" })).toThrow(
      TypeError,
    );
  });

  it("[DUSK-AUTH-PRESET-05] keycloak: issuer from base URL and realm, old /auth prefix kept", () => {
    expect(keycloak({ baseUrl: "https://id.example.com", realm: "main" }).issuer).toBe(
      "https://id.example.com/realms/main",
    );
    expect(keycloak({ baseUrl: "https://id.example.com/auth/", realm: "main" }).issuer).toBe(
      "https://id.example.com/auth/realms/main",
    );
    expect(() => keycloak({ baseUrl: "not a url", realm: "main" })).toThrow(TypeError);
    expect(() => keycloak({ baseUrl: "https://id.example.com", realm: "a/b" })).toThrow(TypeError);
    expect(() => keycloak({ baseUrl: "https://id.example.com?x=1", realm: "main" })).toThrow(
      TypeError,
    );
  });

  it("[DUSK-AUTH-PRESET-06] github is plain OAuth 2.0 and maps its profile", () => {
    const preset = github();
    expect(preset.oauth2).toBe(true);
    expect(preset.endpoints?.userinfo).toBe("https://api.github.com/user");
    expect(
      preset.mapUserinfo?.({
        id: 583231,
        login: "octocat",
        name: null,
        email: "o@example.test",
        avatar_url: "https://a.test/o.png",
      }),
    ).toEqual({
      sub: "583231",
      preferred_username: "octocat",
      name: "octocat",
      email: "o@example.test",
      picture: "https://a.test/o.png",
    });
    expect(preset.mapUserinfo?.({})).not.toHaveProperty("sub");
    const client = createOidcClient({ ...preset, ...registration });
    expect(client).toBeDefined();
  });

  it("[DUSK-AUTH-PRESET-07] discord is plain OAuth 2.0 and maps its profile and avatar", () => {
    const preset = discord();
    expect(preset.oauth2).toBe(true);
    expect(
      preset.mapUserinfo?.({
        id: "80351110224678912",
        username: "nelly",
        global_name: "Nelly",
        avatar: "8342729096ea3675442027381ff50dfe",
        email: "n@example.test",
        verified: true,
      }),
    ).toMatchObject({
      sub: "80351110224678912",
      name: "Nelly",
      email: "n@example.test",
      email_verified: true,
      picture:
        "https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png",
    });
    expect(preset.mapUserinfo?.({ id: "1", username: "u" })["picture"]).toBeUndefined();
    expect(() => createOidcClient({ ...preset, ...registration })).not.toThrow();
  });

  it("[DUSK-AUTH-PRESET-08] every endpoint of every preset is https", () => {
    const all = [
      google(),
      microsoft({ tenant: "common" }),
      auth0({ domain: "x.auth0.com" }),
      okta({ domain: "x.okta.com" }),
      keycloak({ baseUrl: "https://k.example", realm: "r" }),
      github(),
      discord(),
    ];
    for (const preset of all) {
      for (const value of [preset.issuer, ...Object.values(preset.endpoints ?? {})]) {
        if (value !== undefined) expect(value.startsWith("https://"), value).toBe(true);
      }
    }
  });
});
