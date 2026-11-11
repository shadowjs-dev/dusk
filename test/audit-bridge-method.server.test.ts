import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";

const servers: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The status of a request with a method that `fetch` refuses to send. */
function rawRequest(url: string, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("audit: the Node bridge", () => {
  it("[DUSK-AUD-01] TRACE is answered 501 by the handler, not a 500 with a reported failure", async () => {
    const failures: unknown[] = [];
    const server = await serve(
      { fetch: async () => new Response("never reached", { status: 200 }) },
      { port: 0, shutdownSignals: false, onError: (error) => failures.push(error) },
    );
    servers.push(server);
    const trace = await rawRequest(`${server.url}/`, "TRACE");
    expect(failures).toEqual([]);
    expect(trace).toBe(501);
  });
});
