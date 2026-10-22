import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import fc from "fast-check";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { isRefusedImageAddress, isRefusedImageHost } from "../src/server/image-hosts";
import { safeImageFetch } from "../src/server/image-safe-fetch";
import { type SharpFactory, sharpProcessor } from "../src/server/image-sharp";
import {
  createHandler,
  type DuskRuntimeManifest,
  type ImageProcessor,
  type ImagesOptions,
} from "../src/server/index";
import { allFeatures } from "./support/features";

/**
 * PASS 2 audit, area ASSET (images): the sharp processor, the `/_dusk/image` route and the connect-time address
 * check of the remote fetch. Ids are SEC2-ASSET-nn. Network is never touched: remote sources come from a stub
 * `fetch`, and the one test that opens sockets talks to a server on 127.0.0.1 with a stub resolver.
 */

const SEED = 20_261_010;

function handlerWith(images: ImagesOptions, fetchImpl?: typeof fetch) {
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
  };
  const errors: unknown[] = [];
  const handler = createHandler({
    features: allFeatures(),
    manifest,
    dev: true,
    security: { allowedHosts: ["example.com"] },
    images: fetchImpl === undefined ? images : { ...images, fetch: fetchImpl },
    onError: (error) => errors.push(error),
    onWarning: () => undefined,
  });
  return { handler, errors };
}

function get(handler: ReturnType<typeof handlerWith>["handler"], query: string) {
  return handler.fetch(new Request(`https://example.com/_dusk/image?${query}`));
}

const remoteQuery = (url: string, extra = "w=640&q=75"): string =>
  `url=${encodeURIComponent(url)}&${extra}`;

/** A PNG chunk with its CRC. */
function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A 1-bit gray PNG of `width` x `height` all zero: a few KB on the wire, hundreds of megapixels once decoded. */
function bombPng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  header[9] = 0;
  const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

async function realJpegWithMetadata(): Promise<Uint8Array> {
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#336699" },
  })
    .withExif({ IFD0: { Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N" } })
    .withIccProfile("p3")
    .jpeg()
    .toBuffer();
  return new Uint8Array(bytes);
}

const localOf =
  (bytes: Uint8Array, contentType: string): NonNullable<ImagesOptions["source"]> =>
  async (path) =>
    path === "/a" ? { bytes, contentType } : undefined;

describe("SEC2-ASSET sharp processor", () => {
  it("[SEC2-ASSET-01] the factory is given a pixel limit, sequential read and single-frame decoding", async () => {
    const seen: unknown[] = [];
    const real = sharp;
    const spy: SharpFactory = (input, options) => {
      seen.push(options);
      return real(input, options) as never;
    };
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
    );
    await sharpProcessor({ sharp: spy }).process({
      source: { bytes: png, contentType: "image/png" },
      width: 640,
      quality: 75,
      format: "webp",
    });
    expect(seen).toHaveLength(1);
    const options = seen[0] as {
      limitInputPixels?: unknown;
      sequentialRead?: unknown;
      animated?: unknown;
    };
    expect(typeof options.limitInputPixels).toBe("number");
    expect(options.limitInputPixels as number).toBeGreaterThan(0);
    expect(options.limitInputPixels as number).toBeLessThanOrEqual(50_000_000);
    expect(options.sequentialRead).toBe(true);
    expect(options.animated).toBe(false);
  });

  it("[SEC2-ASSET-02] a decompression bomb (a few KB, 144 megapixels) is refused with a 4xx before it is decoded", async () => {
    const bomb = bombPng(12_000, 12_000);
    expect(bomb.byteLength).toBeLessThan(100_000);
    const { handler, errors } = handlerWith({
      processor: sharpProcessor(),
      source: localOf(bomb, "image/png"),
    });
    const response = await get(handler, "url=%2Fa&w=640&q=75&f=webp");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(errors).toHaveLength(0);
  });

  it("[SEC2-ASSET-03] the pixel limit can be tightened and a source over it is refused (injected codec)", async () => {
    let decoded = false;
    const stub: SharpFactory = () => ({
      rotate() {
        return this;
      },
      resize() {
        decoded = true;
        return this;
      },
      webp() {
        return this;
      },
      avif() {
        return this;
      },
      jpeg() {
        return this;
      },
      png() {
        return this;
      },
      metadata: async () => ({ format: "png", width: 5000, height: 5000 }),
      toBuffer: async () => new Uint8Array([1]),
    });
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    await expect(
      sharpProcessor({ sharp: stub, maxInputPixels: 1_000_000 }).process({
        source: { bytes, contentType: "image/png" },
        width: 640,
        quality: 75,
        format: "webp",
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(decoded).toBe(false);
  });

  it("[SEC2-ASSET-04] SVG bytes under a raster content type never reach sharp (DOCTYPE, entity and file: reference)", async () => {
    const svg = new TextEncoder().encode(
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50" height="50"><image xlink:href="file:///etc/hosts" width="50" height="50"/><text>&x;</text></svg>`,
    );
    let called = 0;
    const counting: SharpFactory = (input, options) => {
      called += 1;
      return sharp(input, options) as never;
    };
    const { handler } = handlerWith({
      processor: sharpProcessor({ sharp: counting }),
      source: localOf(svg, "image/png"),
    });
    const response = await get(handler, "url=%2Fa&w=640&q=75&f=png");
    expect(response.status).toBe(415);
    expect(called).toBe(0);
  });

  it("[SEC2-ASSET-05] an SVG under an SVG type is served as a sandboxed attachment, byte for byte, and is not parsed", async () => {
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="http://169.254.169.254/latest/meta-data/"/></svg>`,
    );
    let called = 0;
    const counting: SharpFactory = (input, options) => {
      called += 1;
      return sharp(input, options) as never;
    };
    const { handler } = handlerWith({
      processor: sharpProcessor({ sharp: counting }),
      source: localOf(svg, "image/svg+xml; charset=utf-8"),
    });
    const response = await get(handler, "url=%2Fa&w=640&q=75&f=webp");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(called).toBe(0);
  });

  it("[SEC2-ASSET-06] EXIF (GPS, copyright) and the ICC profile never reach the output, in every encoder", async () => {
    const bytes = await realJpegWithMetadata();
    const input = await sharp(bytes).metadata();
    expect(input.exif).toBeDefined();
    expect(input.icc).toBeDefined();
    const { handler } = handlerWith({
      processor: sharpProcessor(),
      source: localOf(bytes, "image/jpeg"),
      qualities: [75],
    });
    for (const format of ["webp", "jpeg", "png", "avif", "original"]) {
      const response = await get(handler, `url=%2Fa&w=640&q=75&f=${format}`);
      expect(response.status).toBe(200);
      const out = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(out.exif, `exif in ${format}`).toBeUndefined();
      expect(out.icc, `icc in ${format}`).toBeUndefined();
    }
  });

  it("[SEC2-ASSET-07] an animated source yields one frame (the first), whatever its frame count", async () => {
    const frames = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        sharp({
          create: { width: 16, height: 16, channels: 3, background: { r: index * 6, g: 0, b: 0 } },
        })
          .png()
          .toBuffer(),
      ),
    );
    const animated = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages ?? 1).toBeGreaterThan(10);
    const { handler } = handlerWith({
      processor: sharpProcessor(),
      source: localOf(new Uint8Array(animated), "image/gif"),
    });
    const response = await get(handler, "url=%2Fa&w=640&q=75&f=webp");
    expect(response.status).toBe(200);
    const out = await sharp(Buffer.from(await response.arrayBuffer()), {
      animated: true,
    }).metadata();
    expect(out.pages ?? 1).toBe(1);
  });

  it("[SEC2-ASSET-08] no request can ask for SVG (or any format outside the list) as output", async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
    );
    const { handler } = handlerWith({
      processor: sharpProcessor(),
      source: localOf(png, "image/png"),
    });
    for (const format of ["svg", "SVG", "gif", "pdf", "webp,svg", "webp%00svg"]) {
      expect((await get(handler, `url=%2Fa&w=640&q=75&f=${format}`)).status).toBe(400);
    }
  });
});

describe("SEC2-ASSET image route", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const cdn = "https://cdn.example/a.png";

  it("[SEC2-ASSET-10] a fetch that followed a redirect on its own (response.redirected, another final URL) is a 502", async () => {
    const followed: typeof fetch = async () => {
      const response = new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      Object.defineProperty(response, "redirected", { value: true });
      Object.defineProperty(response, "url", { value: "http://169.254.169.254/latest/meta-data/" });
      return response;
    };
    const { handler } = handlerWith({ remotePatterns: ["https://cdn.example"] }, followed);
    expect((await get(handler, remoteQuery(cdn))).status).toBe(502);
  });

  it("[SEC2-ASSET-11] a redirect status from an allow-listed origin is never followed: one fetch, a 502", async () => {
    const calls: string[] = [];
    const redirecting: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8080/admin" },
      });
    };
    const { handler } = handlerWith({ remotePatterns: ["https://cdn.example"] }, redirecting);
    expect((await get(handler, remoteQuery(cdn))).status).toBe(502);
    expect(calls).toEqual([cdn]);
  });

  it("[SEC2-ASSET-12] a URL with credentials is refused even on an allowed origin", async () => {
    const calls: string[] = [];
    const recording: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    };
    const { handler } = handlerWith({ remotePatterns: ["https://cdn.example"] }, recording);
    for (const url of [
      "https://user:pw@cdn.example/a.png",
      "https://user@cdn.example/a.png",
      "https://:pw@cdn.example/a.png",
    ]) {
      expect((await get(handler, remoteQuery(url))).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("[SEC2-ASSET-13] w and q are read in one canonical form: digits only, each key once, no other keys", async () => {
    const calls: string[] = [];
    const recording: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    };
    const { handler } = handlerWith({ remotePatterns: ["https://cdn.example"] }, recording);
    const u = encodeURIComponent(cdn);
    const bad = [
      `url=${u}&w=6.4e2&q=75`,
      `url=${u}&w=0640&q=75`,
      `url=${u}&w=%2B640&q=75`,
      `url=${u}&w=0x280&q=75`,
      `url=${u}&w=%20640&q=75`,
      `url=${u}&w=640&q=7.5e1`,
      `url=${u}&w=640&q=075`,
      `url=${u}&w=640&q=%2B75`,
      `url=${u}&w=NaN&q=75`,
      `url=${u}&w=-640&q=75`,
      `url=${u}&w=Infinity&q=75`,
      `url=${u}&w=640&w=750&q=75`,
      `url=${u}&w=640&q=75&q=75`,
      `url=${u}&url=${u}&w=640&q=75`,
      `url=${u}&w[]=640&q=75`,
      `url=${u}&w=640,750&q=75`,
      `url=${u}&w=640&q=75&cachebust=1`,
      `url=${u}&w=640&q=75&f=webp&f=webp`,
    ];
    for (const query of bad) {
      expect((await get(handler, query)).status, query).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await get(handler, `url=${u}&w=640&q=75`)).status).toBe(200);
  });

  it("[SEC2-ASSET-14] fuzz: any w or q that is not canonical digits is a 400 and reads no source", () => {
    const cdnUrl = encodeURIComponent(cdn);
    return fc.assert(
      fc.asyncProperty(
        fc
          .oneof(
            fc.string({ maxLength: 12 }),
            fc
              .constantFrom(640, 750, 828, 1080)
              .chain((width) =>
                fc.constantFrom(
                  `0${width}`,
                  `+${width}`,
                  ` ${width}`,
                  `${width} `,
                  `${width}.0`,
                  `${width}e0`,
                  `${width / 10}e1`,
                  `0x${width.toString(16)}`,
                ),
              ),
          )
          .filter((value) => !/^[1-9]\d{0,4}$/.test(value)),
        fc
          .oneof(
            fc.string({ maxLength: 12 }),
            fc.constantFrom("075", "+75", " 75", "75.0", "7.5e1", "0x4b", "75 ", "-75"),
          )
          .filter((value) => !/^[1-9]\d{0,2}$/.test(value)),
        async (w, q) => {
          let fetched = 0;
          const counting: typeof fetch = async () => {
            fetched += 1;
            return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
          };
          const { handler } = handlerWith({ remotePatterns: ["https://cdn.example"] }, counting);
          const response = await get(
            handler,
            `url=${cdnUrl}&w=${encodeURIComponent(w)}&q=${encodeURIComponent(q)}`,
          );
          expect(response.status).toBe(400);
          expect(fetched).toBe(0);
        },
      ),
      { seed: SEED, numRuns: 150 },
    );
  });

  it("[SEC2-ASSET-15] Content-Length is not trusted: a small claim with a body past the cap is a 502 and stops reading", async () => {
    let pulled = 0;
    const lying: typeof fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "10" },
      });
    };
    const { handler } = handlerWith(
      { remotePatterns: ["https://cdn.example"], maxSourceBytes: 4096 },
      lying,
    );
    expect((await get(handler, remoteQuery(cdn))).status).toBe(502);
    expect(pulled).toBeLessThan(16);
  });

  it("[SEC2-ASSET-16] a source that never finishes is cut by the timeout through the abort signal", async () => {
    const stalling: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const { handler } = handlerWith(
      { remotePatterns: ["https://cdn.example"], timeoutMs: 1 },
      stalling,
    );
    const response = await get(handler, remoteQuery(cdn));
    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("[SEC2-ASSET-17] a processor that is slow does not hold the source permit forever: the permit is released on a throw", async () => {
    const failing: ImageProcessor = {
      async process() {
        throw new Error("boom");
      },
    };
    const { handler } = handlerWith({
      processor: failing,
      source: localOf(PNG, "image/png"),
      maxConcurrentFetches: 1,
    });
    for (let index = 0; index < 3; index += 1) {
      expect((await get(handler, "url=%2Fa&w=640&q=75")).status).toBe(500);
    }
  });
});

describe("SEC2-ASSET refused hosts", () => {
  const hostOf = (url: string): string => new URL(url).hostname;

  it("[SEC2-ASSET-20] loopback, private, link-local and metadata hosts are refused in every spelling", () => {
    const refused = [
      "http://localhost./",
      "http://LOCALHOST/",
      "http://foo.localhost./",
      "http://printer.local./",
      "http://db.internal./",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f.1/",
      "http://0177.0.0.1/",
      "http://2130706433/",
      "http://0.0.0.0/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/",
      "http://100.100.100.200/",
      "http://192.0.0.192/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
      "http://[fe80::1]/",
      "http://[fec0::1]/",
      "http://[fc00::1]/",
      "http://[fd00:ec2::254]/",
      "http://[ff02::1]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:7f00:1::]/",
      "http://[2002:a9fe:a9fe::1]/",
    ];
    for (const url of refused) {
      expect(isRefusedImageHost(hostOf(url)), url).toBe(true);
    }
  });

  it("[SEC2-ASSET-21] public hosts are not refused (the allow-list is not a deny-everything list)", () => {
    for (const url of [
      "https://cdn.example/",
      "http://8.8.8.8/",
      "http://[2606:4700:4700::1111]/",
      "http://[64:ff9b::808:808]/",
      "http://[2002:808:808::1]/",
    ]) {
      expect(isRefusedImageHost(hostOf(url)), url).toBe(false);
    }
  });

  it("[SEC2-ASSET-22] a resolved address is checked in the forms a resolver prints", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::7f00:1",
      "0:0:0:0:0:0:0:1",
      "fe80::1%en0",
    ]) {
      expect(isRefusedImageAddress(address), address).toBe(true);
    }
    expect(isRefusedImageAddress("93.184.216.34")).toBe(false);
    expect(isRefusedImageAddress("2606:4700:4700::1111")).toBe(false);
    // Text that is not an address is refused rather than guessed at.
    expect(isRefusedImageAddress("not-an-address")).toBe(true);
    expect(isRefusedImageAddress("")).toBe(true);
  });

  it("[SEC2-ASSET-23] fuzz: any IPv4 in a refused range, written in any URL spelling, is refused", () => {
    const octet = fc.integer({ min: 0, max: 255 });
    const refusedV4 = fc.oneof(
      fc.tuple(fc.constant(10), octet, octet, octet),
      fc.tuple(fc.constant(127), octet, octet, octet),
      fc.tuple(fc.constant(169), fc.constant(254), octet, octet),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
      fc.tuple(fc.constant(192), fc.constant(168), octet, octet),
      fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), octet, octet),
    );
    return fc.assert(
      fc.property(refusedV4, fc.constantFrom("dotted", "int", "hex", "mapped"), (parts, style) => {
        const [a, b, c, d] = parts;
        const number = ((a * 256 + b) * 256 + c) * 256 + d;
        const text =
          style === "dotted"
            ? `${a}.${b}.${c}.${d}`
            : style === "int"
              ? String(number)
              : style === "hex"
                ? `0x${number.toString(16)}`
                : `[::ffff:${a}.${b}.${c}.${d}]`;
        return isRefusedImageHost(new URL(`http://${text}/`).hostname);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});

describe("SEC2-ASSET connect-time address check", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function listen(
    onRequest: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ port: number; connections: () => number }> {
    let connections = 0;
    const server = createServer(onRequest);
    server.on("connection", () => {
      connections += 1;
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, connections: () => connections };
  }

  const resolveTo =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("[SEC2-ASSET-30] a public-looking name that resolves to loopback is refused at connect: no socket is opened", async () => {
    const target = await listen((_request, response) => response.end("secret"));
    const fetchImage = safeImageFetch({ lookup: resolveTo("127.0.0.1") });
    await expect(fetchImage(`http://rebind.example:${target.port}/x.png`)).rejects.toThrow(
      /refused|private|not allowed/i,
    );
    expect(target.connections()).toBe(0);
  });

  it("[SEC2-ASSET-31] one private address among public ones refuses the lot (the resolver may rotate)", async () => {
    const target = await listen((_request, response) => response.end("secret"));
    const fetchImage = safeImageFetch({ lookup: resolveTo("93.184.216.34", "::ffff:127.0.0.1") });
    await expect(fetchImage(`http://rebind.example:${target.port}/x.png`)).rejects.toThrow();
    expect(target.connections()).toBe(0);
  });

  it("[SEC2-ASSET-32] a literal private IP is refused without a lookup", async () => {
    const target = await listen((_request, response) => response.end("secret"));
    let lookups = 0;
    const fetchImage = safeImageFetch({
      lookup: async () => {
        lookups += 1;
        return [];
      },
    });
    await expect(fetchImage(`http://127.0.0.1:${target.port}/x.png`)).rejects.toThrow();
    expect(target.connections()).toBe(0);
    expect(lookups).toBe(0);
  });

  it("[SEC2-ASSET-33] only http and https are fetched", async () => {
    const fetchImage = safeImageFetch({ lookup: resolveTo("93.184.216.34") });
    for (const url of ["file:///etc/passwd", "ftp://cdn.example/x", "data:image/png;base64,AAAA"]) {
      await expect(fetchImage(url)).rejects.toThrow();
    }
  });

  it("[SEC2-ASSET-34] when the address passes, the body streams and a redirect is returned, not followed", async () => {
    const target = await listen((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71]));
    });
    // The test target is on loopback, so the predicate that refuses loopback is switched off for this one test.
    const fetchImage = safeImageFetch({ lookup: resolveTo("127.0.0.1"), refuse: () => false });
    const ok = await fetchImage(`http://cdn.example:${target.port}/x.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    const redirect = await fetchImage(`http://cdn.example:${target.port}/redirect`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
    expect(target.connections()).toBe(2);
  });

  it("[SEC2-ASSET-35] the abort signal ends a stalled request", async () => {
    const target = await listen(() => {
      // never answers
    });
    const fetchImage = safeImageFetch({ lookup: resolveTo("127.0.0.1"), refuse: () => false });
    const controller = new AbortController();
    const pending = fetchImage(`http://cdn.example:${target.port}/x.png`, {
      signal: controller.signal,
    });
    pending.catch(() => undefined);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
  });
});
