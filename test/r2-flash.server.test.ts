import { describe, expect, it, vi } from "vitest";
import { setFlash, takeFlash } from "../src/server/flash";
import { FLASH_COOKIE } from "../src/shared/action";
import { createTestEvent } from "../src/testing/index";

const SECRET = "0123456789abcdef0123456789abcdef";

/** A request that arrives with `value` signed into the flash cookie, as a browser would send it back. */
async function arriving(value: string) {
  const first = createTestEvent({ cookieSecrets: [SECRET] });
  await first.cookies.setSigned(FLASH_COOKIE, value, { path: "/" });
  const line = first.cookies.serialized().find((entry) => entry.startsWith(`${FLASH_COOKIE}=`));
  if (line === undefined) throw new Error("the flash cookie was not written");
  const sent = (line.split(";")[0] ?? "").slice(FLASH_COOKIE.length + 1);
  return createTestEvent({
    cookieSecrets: [SECRET],
    cookies: { [FLASH_COOKIE]: decodeURIComponent(sent) },
  });
}

describe("flash: a cookie that cannot be read", () => {
  it("[DUSK-R2-9] a signed value that does not decode reads as no flash and is reported", async () => {
    const report = vi.fn();
    // Valid base64url, but not the wire codec.
    const event = await arriving("bm90IHRoZSB3aXJlIGNvZGVj");
    expect(await takeFlash(event, report)).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("[DUSK-R2-9] a good flash is returned and nothing is reported", async () => {
    const report = vi.fn();
    const writer = createTestEvent({ cookieSecrets: [SECRET] });
    await setFlash(writer, { notice: "Saved." });
    const line = writer.cookies.serialized().find((entry) => entry.startsWith(`${FLASH_COOKIE}=`));
    const sent = decodeURIComponent((line?.split(";")[0] ?? "").slice(FLASH_COOKIE.length + 1));
    const event = createTestEvent({ cookieSecrets: [SECRET], cookies: { [FLASH_COOKIE]: sent } });
    expect(await takeFlash(event, report)).toEqual({ flash: { notice: "Saved." } });
    expect(report).not.toHaveBeenCalled();
  });
});
