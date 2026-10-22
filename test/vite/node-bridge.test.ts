import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BadRequestError, toWebRequest, writeWebResponse } from "../../src/vite/node-bridge";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(
  handler: (request: Request, signal: AbortSignal) => Promise<Response> | Response,
  seen?: { aborted: boolean },
): Promise<string> {
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) {
        controller.abort();
        if (seen) seen.aborted = true;
      }
    });
    void (async () => {
      try {
        const request = toWebRequest(req, { protocol: "http", signal: controller.signal });
        await writeWebResponse(
          res,
          await handler(request, controller.signal),
          request.method === "HEAD",
        );
      } catch (error) {
        if (error instanceof BadRequestError) {
          res.statusCode = 400;
          res.end(error.message);
        } else {
          res.destroy();
        }
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("dev node bridge", () => {
  it("[SBRG-01] the request carries method, URL, headers (duplicates kept) and a streamed body", async () => {
    const origin = await listen(async (request) => {
      const body = await request.text();
      return Response.json({
        method: request.method,
        url: request.url,
        cookie: request.headers.get("cookie"),
        accept: request.headers.get("accept"),
        body,
      });
    });
    const response = await fetch(`${origin}/a/b?x=1&y=%20`, {
      method: "POST",
      headers: { cookie: "a=1", accept: "text/plain, text/html" },
      body: "hello body",
    });
    expect(await response.json()).toEqual({
      method: "POST",
      url: `${origin}/a/b?x=1&y=%20`,
      cookie: "a=1",
      accept: "text/plain, text/html",
      body: "hello body",
    });
  });

  it("[SBRG-02] several Set-Cookie headers stay separate; status and text are kept", async () => {
    const origin = await listen(() => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/; HttpOnly");
      return new Response("created", { status: 201, headers });
    });
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
    expect(await response.text()).toBe("created");
  });

  it("[SBRG-03] a streamed body arrives in order and completely", async () => {
    const encoder = new TextEncoder();
    const origin = await listen(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < 50; index += 1)
                controller.enqueue(encoder.encode(`chunk-${index};`));
              controller.close();
            },
          }),
        ),
    );
    const text = await (await fetch(`${origin}/`)).text();
    expect(text).toBe(Array.from({ length: 50 }, (_, index) => `chunk-${index};`).join(""));
  });

  it("[SBRG-04] HEAD sends headers without a body", async () => {
    const origin = await listen(
      () => new Response("body that is not sent", { headers: { "x-test": "1" } }),
    );
    const response = await fetch(`${origin}/`, { method: "HEAD" });
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.text()).toBe("");
  });

  it("[SBRG-05] a client that goes away aborts the request signal", async () => {
    const seen = { aborted: false };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalAborted: Promise<void> = Promise.resolve();
    const origin = await listen(async (_request, signal) => {
      signalAborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve()),
      );
      release();
      await signalAborted;
      return new Response("never read");
    }, seen);
    const url = new URL(origin);
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: "/" }, () => undefined);
      req.on("error", () => resolve());
      req.end();
      void gate.then(() => {
        req.destroy();
        resolve();
      });
    });
    await signalAborted;
    expect(seen.aborted).toBe(true);
  });

  it("[SBRG-06] a request line the URL parser cannot use is a BadRequestError (400)", async () => {
    const origin = await listen(() => new Response("never"));
    const url = new URL(origin);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: "//" }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(answer).toEqual({ status: 400, body: "invalid request URL" });
  });

  it("[SBRG-07] a request without a Host header is refused (by Node, before the bridge)", async () => {
    const origin = await listen(() => new Response("never"));
    const url = new URL(origin);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: url.hostname, port: url.port, path: "/", setHost: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it("[SBRG-08] toWebRequest itself rejects a missing Host header", () => {
    expect(() =>
      toWebRequest(
        { headers: {}, url: "/", method: "GET" } as unknown as Parameters<typeof toWebRequest>[0],
        { protocol: "http", signal: new AbortController().signal },
      ),
    ).toThrow(BadRequestError);
  });
});
