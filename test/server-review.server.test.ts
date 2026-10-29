import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { images } from "../src/features/images";
import { rpc } from "../src/features/rpc";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  type HandlerOptions,
  json,
  redirect,
  serverFn,
} from "../src/server/index";
import { mergeVary } from "../src/server/vary";
import { CLOSE, FrameReader, WebSocketProtocolError } from "../src/server/ws-protocol";

/**
 * Defects found by the server review round. Each test pins what the code does now that the defect is fixed. The apps
 * are plain TypeScript (no JSX), so they use only the features the case needs.
 */

const ORIGIN = "https://app.test";

function manifest(
  routes: Record<string, unknown>,
  fns: Record<string, unknown> = {},
): DuskRuntimeManifest {
  return {
    routes: [],
    apiRoutes: Object.entries(routes).map(([path, module]) => ({
      id: path,
      path,
      load: async () => module as never,
    })),
    serverFns: Object.fromEntries(
      Object.entries(fns).map(([id, definition]) => [
        id,
        { load: async () => definition as never },
      ]),
    ),
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
  };
}

function boot(
  routes: Record<string, unknown>,
  options: Partial<HandlerOptions> = {},
  fns: Record<string, unknown> = {},
): DuskHandler {
  return createHandler({
    features: [apiRoutes(), rpc()],
    manifest: manifest(routes, fns),
    dev: false,
    security: { allowedHosts: ["app.test"], ...(options.security ?? {}) },
    onError: () => undefined,
    onWarning: () => undefined,
    ...options,
  });
}

describe("redirect locations", () => {
  it("[DUSK-SRV-REV-1] a redirect target with an emoji or a lone surrogate answers a 302 with the text percent-encoded, not a crash", async () => {
    const go = (target: string): DuskHandler =>
      boot({
        "/go": apiRoute({
          GET: () => {
            throw redirect(target);
          },
        }),
      });
    // An emoji is one character of two UTF-16 units; "\ud800" is half of a pair, which a decoded body or query can hold.
    const emoji = await go("/search?q=\u{1F600}").fetch(new Request(`${ORIGIN}/go`));
    expect(emoji.status).toBe(302);
    expect(emoji.headers.get("location")).toBe("/search?q=%F0%9F%98%80");
    const lone = await go("/search?q=\ud800").fetch(new Request(`${ORIGIN}/go`));
    expect(lone.status).toBe(302);
    expect(lone.headers.get("location")).toBe("/search?q=%EF%BF%BD");
  });

  it("[DUSK-SRV-REV-2] a form post whose function redirects to a non-Latin-1 path answers a 303 with the path percent-encoded", async () => {
    const send = serverFn({ form: true }, () => {
      throw redirect("/日本語?x=é");
    });
    const handler = boot({}, {}, { send });
    const response = await handler.fetch(
      new Request(`${ORIGIN}/_dusk/fn/send`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "a=1",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `/${encodeURIComponent("日本語")}?x=${encodeURIComponent("é")}`,
    );
  });
});

describe("CORS keeps Vary: Origin", () => {
  const security = {
    allowedHosts: ["app.test"],
    cors: { origins: ["https://partner.example"] },
  };

  it("[DUSK-SRV-REV-3] an answer that names its own Vary still varies on Origin when the origin is listed", async () => {
    const handler = boot(
      {
        "/items": apiRoute({
          GET: () => json({ ok: true }, { headers: { vary: "accept-encoding" } }),
        }),
      },
      { security },
    );
    const response = await handler.fetch(
      new Request(`${ORIGIN}/items`, { headers: { origin: "https://partner.example" } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("https://partner.example");
    const vary = (response.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/);
    expect(vary).toContain("origin");
    expect(vary).toContain("accept-encoding");
  });

  it("[DUSK-SRV-REV-4] an answer to an origin that is not listed, or to no origin, still varies on Origin", async () => {
    const handler = boot({ "/items": apiRoute({ GET: () => json({ ok: true }) }) }, { security });
    for (const headers of [{ origin: "https://evil.example" }, {}]) {
      const response = await handler.fetch(new Request(`${ORIGIN}/items`, { headers }));
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect((response.headers.get("vary") ?? "").toLowerCase()).toContain("origin");
    }
  });

  it("[DUSK-SRV-REV-5] a preflight from an origin that is not listed still reaches the route and gets no CORS grant", async () => {
    const handler = boot({ "/items": apiRoute({ GET: () => json({ ok: true }) }) }, { security });
    const response = await handler.fetch(
      new Request(`${ORIGIN}/items`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
      }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });
});

describe("the image endpoint answers HEAD", () => {
  it("[DUSK-SRV-REV-6] HEAD gets the headers of the GET and no body; another method is 405 and lists GET and HEAD", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const handler = createHandler({
      features: [images()],
      manifest: manifest({}),
      dev: false,
      security: { allowedHosts: ["app.test"] },
      images: { source: async () => ({ bytes: png, contentType: "image/png" }) },
      onError: () => undefined,
      onWarning: () => undefined,
    });
    const url = `${ORIGIN}/_dusk/image?url=%2Fhero.png&w=640&q=75`;
    const get = await handler.fetch(new Request(url));
    const head = await handler.fetch(new Request(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(await head.text()).toBe("");
    const post = await handler.fetch(
      new Request(url, { method: "POST", headers: { origin: ORIGIN } }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("WebSocket fragments", () => {
  /** A masked client frame (the mask key is zero, so the payload is plain). */
  function frame(opcode: number, fin: boolean, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + 4 + payload.byteLength);
    out[0] = (fin ? 0x80 : 0) | opcode;
    out[1] = 0x80 | payload.byteLength;
    out.set(payload, 6);
    return out;
  }

  it("[DUSK-SRV-REV-7] a message made of endless empty continuation frames is refused with 1009 instead of held in memory", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024 * 1024, requireMask: true });
    reader.push(frame(0x1, false, new Uint8Array(0)));
    const empty = frame(0x0, false, new Uint8Array(0));
    let error: unknown;
    try {
      for (let sent = 0; sent < 100_000; sent += 1) reader.push(empty);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(WebSocketProtocolError);
    expect((error as WebSocketProtocolError).code).toBe(CLOSE.TOO_BIG);
  });

  it("[DUSK-SRV-REV-8] a message in a normal number of fragments still arrives whole", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024 * 1024, requireMask: true });
    const piece = new Uint8Array(100).fill(0x61);
    const events = [];
    events.push(...reader.push(frame(0x1, false, piece)));
    for (let index = 0; index < 500; index += 1)
      events.push(...reader.push(frame(0x0, false, piece)));
    events.push(...reader.push(frame(0x0, true, piece)));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("text");
    expect((events[0] as { data: Uint8Array }).data.byteLength).toBe(502 * 100);
  });
});

describe("merging Vary", () => {
  it("[DUSK-SRV-REV-19] names are added once without regard to case, and * stands for everything", () => {
    const headers = new Headers({ vary: "Accept-Encoding, Origin" });
    mergeVary(headers, "origin, Cookie");
    expect(headers.get("vary")).toBe("Accept-Encoding, Origin, Cookie");
    mergeVary(headers, "*");
    expect(headers.get("vary")).toBe("*");
    mergeVary(headers, "accept");
    expect(headers.get("vary")).toBe("*");
    const empty = new Headers();
    mergeVary(empty, " ,Origin,");
    expect(empty.get("vary")).toBe("Origin");
  });
});
