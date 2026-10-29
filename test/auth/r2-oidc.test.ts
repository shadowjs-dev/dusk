import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, startApp } from "./support/app";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function app(options: Parameters<typeof startApp>[0] = {}): Promise<App> {
  const a = await startApp(options);
  apps.push(a);
  return a;
}

async function code(response: Response): Promise<unknown> {
  return ((await response.json()) as Record<string, unknown>)["code"];
}

describe("OIDC signOut: a revocation that fails is reported", () => {
  it("[DUSK-R2-2] the failure goes to report, the session still ends and the redirect still happens", async () => {
    const report = vi.fn();
    const down = new Error("revocation endpoint is down");
    const a = await app({
      endpoints: true,
      client: {
        report,
        fetch: async (input, init) => {
          if (String(input).endsWith("/revoke")) throw down;
          return globalThis.fetch(input, init);
        },
      },
    });
    await a.signIn();
    const out = await a.client.post("/auth/logout");
    expect(out.status).toBe(303);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ cause: down });
    expect((await a.client.get("/me")).status).toBe(401);
  });
});

describe("OIDC refresh: the subject of the new ID token", () => {
  it("[DUSK-R2-2] with the user gone from the session, a refreshed ID token for the same subject as the stored one is accepted", async () => {
    const a = await app();
    await a.signIn();
    await a.client.post("/test/forget-user");
    const refreshed = await a.client.post("/auth/token");
    expect(refreshed.status).toBe(200);
  });

  it("[DUSK-R2-2] with the user gone, a refreshed ID token for another subject than the stored one is refused", async () => {
    const a = await app();
    await a.signIn();
    await a.client.post("/test/forget-user");
    a.idp.hooks.claims = (claims) => ({ ...claims, sub: "someone-else" });
    const refreshed = await a.client.post("/auth/token");
    expect(refreshed.status).toBe(401);
    expect(await code(refreshed)).toBe("OIDC_ID_TOKEN_INVALID");
  });

  it("[DUSK-R2-2] with neither the user nor a stored ID token, a refreshed ID token cannot be compared and is refused (fail closed)", async () => {
    const a = await app();
    await a.signIn();
    await a.client.post("/test/forget-user?noIdToken=1");
    const refreshed = await a.client.post("/auth/token");
    expect(refreshed.status).toBe(401);
    expect(await code(refreshed)).toBe("OIDC_ID_TOKEN_INVALID");
  });

  it("[DUSK-R2-2] with the user present, another subject is still refused", async () => {
    const a = await app();
    await a.signIn();
    a.idp.hooks.claims = (claims) => ({ ...claims, sub: "someone-else" });
    const refreshed = await a.client.post("/auth/token");
    expect(await code(refreshed)).toBe("OIDC_ID_TOKEN_INVALID");
  });
});
