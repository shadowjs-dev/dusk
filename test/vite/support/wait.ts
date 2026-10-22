import { deserialize, serialize } from "@shadow-js/web/server";

/**
 * Polls an HTTP condition without sleeping on a timer: each retry waits for the next macrotask,
 * and the whole wait is bounded by the test timeout. The route scan runs on a file system event,
 * which has no hook a test can await across the HTTP boundary.
 */

interface Origin {
  readonly origin: string;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for ${what}`);
}

export async function untilStatus(dev: Origin, path: string, status: number): Promise<void> {
  await until(
    async () => (await fetch(`${dev.origin}${path}`)).status === status,
    `${path} to answer ${status}`,
  );
}

export async function untilRpc(dev: Origin, id: string, expected: unknown): Promise<void> {
  await until(async () => {
    const response = await fetch(`${dev.origin}/_dusk/fn/${id}`, {
      method: "POST",
      headers: {
        "x-dusk-fn": "1",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: serialize([undefined]),
    });
    const body: unknown = deserialize(await response.text());
    return JSON.stringify(body) === JSON.stringify(expected);
  }, `server function ${id}`);
}
