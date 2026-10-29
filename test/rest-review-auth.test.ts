import { describe, expect, it } from "vitest";
import { requireUser } from "../src/auth/index";
import { isRedirect } from "../src/server/index";
import { createTestEvent } from "../src/testing/index";

const anonymous = { user: async () => undefined };

async function redirectTarget(loginPath: string): Promise<string> {
  try {
    await requireUser(anonymous, { loginPath })(
      createTestEvent({ url: "https://app.test/a/b?c=1", method: "GET" }),
    );
  } catch (thrown) {
    if (isRedirect(thrown)) return thrown.to;
    throw thrown;
  }
  throw new Error("the guard did not redirect");
}

describe("requireUser: the login redirect", () => {
  it("[DUSK-REST-REV-12] returnTo joins a login path that already has a query with &, not a second ?", async () => {
    expect(await redirectTarget("/login")).toBe("/login?returnTo=%2Fa%2Fb%3Fc%3D1");
    expect(await redirectTarget("/login?lang=fr")).toBe("/login?lang=fr&returnTo=%2Fa%2Fb%3Fc%3D1");
  });
});
