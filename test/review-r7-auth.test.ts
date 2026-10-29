import { afterEach, describe, expect, it } from "vitest";
import { createJwksCache } from "../src/auth/index";
import { type App, startApp } from "./auth/support/app";
import { type Idp, startIdp } from "./auth/support/idp";

const apps: App[] = [];
const idps: Idp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const i of idps.splice(0)) await i.close();
});

/** A gate the test opens: a fetch waits for it, then goes to the real provider with the signal it was given. */
function gate(): { readonly open: () => void; readonly wait: Promise<void> } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe("shared discovery and key set fetches do not belong to the first caller", () => {
  it("[DUSK-R7-2] a caller that disconnects does not fail the discovery the others wait for", async () => {
    const held = gate();
    let discoveries = 0;
    const a = await startApp({
      client: {
        fetch: async (input, init) => {
          if (String(input).includes(".well-known")) {
            discoveries += 1;
            await held.wait;
          }
          return globalThis.fetch(input, init);
        },
      },
    });
    apps.push(a);
    const leaving = new AbortController();
    const first = a.client.get("/auth/login", { signal: leaving.signal }).catch(() => undefined);
    const second = a.client.get("/auth/login");
    await new Promise<void>((resolve) => setImmediate(resolve));
    leaving.abort();
    held.open();
    await first;
    const answered = await second;
    expect(answered.status).toBe(302);
    expect(discoveries).toBe(1);
    // No retry delay was recorded: a later caller discovers at once.
    expect((await a.client.get("/auth/login")).status).toBe(302);
  });

  it("[DUSK-R7-2] a caller that disconnects does not fail the key set fetch the others wait for", async () => {
    const idp = await startIdp({ alg: "ES256" });
    idps.push(idp);
    const held = gate();
    const slow: typeof fetch = async (input, init) => {
      await held.wait;
      return globalThis.fetch(input, init);
    };
    const base = {
      fetch: slow,
      timeoutMs: 5000,
      maxBytes: 1_048_576,
      allowLoopbackHttp: true,
    };
    const cache = createJwksCache({ uri: `${idp.issuer}/jwks` });
    const leaving = new AbortController();
    const header = { alg: "ES256", kid: idp.key.kid };
    const first = cache
      .key(header, { ...base, signal: leaving.signal })
      .catch((error: unknown) => error);
    const second = cache.key(header, { ...base, signal: undefined });
    leaving.abort();
    held.open();
    await first;
    await expect(second).resolves.toBeDefined();
    // The failed waiter did not poison the cache: the set is in place.
    await expect(cache.key(header, { ...base, signal: undefined })).resolves.toBeDefined();
  });
});
