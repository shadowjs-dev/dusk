import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/**
 * A real HTTP server for tests. `serve` bridges Node's request and response to a Web `fetch`
 * function (the shape of `handler.fetch`), so a client talks to it over a real socket.
 */

export interface TestServer {
  readonly origin: string;
  close(): Promise<void>;
}

/** Converts a Node request to a Web `Request`, streaming the body. */
function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(req.url ?? "/", origin), init);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
  }
  res.end();
}

/**
 * Starts a server on an ephemeral port.
 *
 * @param fetchHandler Answers each request; a rejected promise becomes a 500.
 * @returns The origin and a `close` function.
 */
export async function serve(
  fetchHandler: (request: Request) => Promise<Response> | Response,
): Promise<TestServer> {
  let origin = "";
  const server: Server = createServer((req, res) => {
    Promise.resolve()
      .then(() => fetchHandler(toRequest(req, origin)))
      .then((response) => send(res, response))
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "error");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/**
 * A `fetch` that sends relative URLs to `origin` and marks them as same-origin browser requests
 * (`Sec-Fetch-Site`), which is what a browser does for a page of that origin.
 */
export function browserFetch(origin: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? new URL(input, origin) : input;
    const headers = new Headers(init?.headers);
    headers.set("sec-fetch-site", "same-origin");
    return fetch(url, { ...init, headers });
  };
}
