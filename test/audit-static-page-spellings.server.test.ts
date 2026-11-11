import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeFetch } from "../src/adapter/native";
import { type ServerHandle, serve } from "../src/node/index";
import type { Handler } from "../src/server/types";
import type { StaticPage } from "../src/shared/static-page";

const servers: ServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The body of a GET whose path is sent exactly as written (`fetch` would normalize it). */
function rawBody(url: string): Promise<string> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: url.slice(url.indexOf("/", 8)),
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("audit: a handler-rendered prerendered page is never read from its file", () => {
  /** Paths that name the file of `/posts` but are not its page key (`pageKeyOf`). */
  const SPELLINGS = ["//posts", "/posts//", "/posts/index.html/", "//posts/index.html"];

  async function layout(): Promise<{ dir: string; pages: StaticPage[] }> {
    const dir = mkdtempSync(join(tmpdir(), "dusk-audit-pages-"));
    dirs.push(dir);
    mkdirSync(join(dir, "posts"));
    writeFileSync(join(dir, "posts", "index.html"), "<p>from the file</p>");
    return {
      dir,
      pages: [
        {
          path: "/posts",
          mode: "handler",
          headers: [],
          httpsHeaders: [],
          reason: "a rule applies",
        },
      ],
    };
  }

  const handler = {
    fetch: async () =>
      new Response("from the handler", { headers: { "content-type": "text/plain" } }),
  } as unknown as Handler;

  it("[DUSK-AUD-03] the Node static server hands every spelling of the page to the handler", async () => {
    const { dir, pages } = await layout();
    const server = await serve(handler, {
      port: 0,
      shutdownSignals: false,
      static: { dir, pages, index: "index.html" },
    });
    servers.push(server);
    const seen: Record<string, string> = {};
    for (const path of SPELLINGS) {
      seen[path] = await rawBody(`${server.url}${path}`);
    }
    expect(seen).toEqual(Object.fromEntries(SPELLINGS.map((path) => [path, "from the handler"])));
  });

  it("[DUSK-AUD-04] the Bun and Deno static path hands every spelling of the page to the handler", async () => {
    const { dir, pages } = await layout();
    const fetchFn = createNativeFetch(handler, {
      static: dir,
      compress: false,
      onError: (error) => {
        throw error;
      },
      pages,
    });
    const seen: Record<string, string> = {};
    for (const path of SPELLINGS) {
      seen[path] = await (await fetchFn(new Request(`http://localhost${path}`), undefined)).text();
    }
    expect(seen).toEqual(Object.fromEntries(SPELLINGS.map((path) => [path, "from the handler"])));
  });
});
