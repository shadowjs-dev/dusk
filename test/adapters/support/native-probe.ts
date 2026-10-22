/**
 * A small app for the native runtime tests (run under Bun or Deno as a child process). It answers
 * the routes the tests need: a streamed body with a delay between chunks, a buffered text body (for
 * gzip), the client address the runtime reports, a slow request (for graceful stop), a failure, and
 * a 404 for everything else. Static files come from `STATIC_DIR` when it is set.
 */
import { serve } from "../../../src/bun/index";

const SLOW_MS = Number(process.env["SLOW_MS"] ?? 800);
const text = "<p>buffered text, repeated to be compressible</p>\n".repeat(120);

const handler = {
  fetch(request: Request, platform?: unknown): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/stream") {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("<html>first"));
          await new Promise((resolve) => setTimeout(resolve, 1200));
          controller.enqueue(encoder.encode(" second</html>"));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }),
      );
    }
    if (path === "/buffered") {
      return Promise.resolve(
        new Response(text, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(new TextEncoder().encode(text).byteLength),
          },
        }),
      );
    }
    if (path === "/client") {
      const address =
        typeof platform === "object" && platform !== null
          ? Reflect.get(platform, "clientAddress")
          : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ address: address ?? null }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (path === "/slow") {
      return new Promise((resolve) =>
        setTimeout(
          () => resolve(new Response("slow ok", { headers: { "content-type": "text/plain" } })),
          SLOW_MS,
        ),
      );
    }
    if (path === "/boom") {
      return Promise.reject(new Error("boom"));
    }
    return Promise.resolve(
      new Response("handler: not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );
  },
};

const server = await serve(handler, {
  port: Number(process.env["PORT"] ?? 0),
  hostname: "127.0.0.1",
  static: process.env["STATIC_DIR"] ?? false,
  onError: (error: unknown) => {
    process.stdout.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  },
});
process.stdout.write(`READY ${server.port}\n`);
