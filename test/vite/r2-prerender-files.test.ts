import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrerenderError, prerenderFile, prerenderPages } from "../../src/vite/build";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeServer(source: string): { entry: string; clientDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "dusk-r2-prerender-"));
  dirs.push(dir);
  mkdirSync(join(dir, "server"));
  const entry = join(dir, "server", "entry.mjs");
  writeFileSync(entry, source);
  return { entry, clientDir: join(dir, "client") };
}

const SERVER = `
const types = { "/sitemap.xml": "application/xml", "/robots.txt": "text/plain", "/v1.2": "text/html; charset=utf-8", "/docs/index.html": "text/html; charset=utf-8" };
export const handler = {
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const links = path === "/" ? '<a href="/About">a</a><a href="/about">b</a>' : "";
    return new Response("<body>" + path + links + "</body>", { headers: { "content-type": types[path] ?? "text/html; charset=utf-8" } });
  },
};`;

const CLIENT = join(tmpdir(), "client");

describe("prerendered files with an extension", () => {
  it("[DUSK-R2-5] prerenderFile writes a non-HTML path with an extension as that file", () => {
    expect(prerenderFile(CLIENT, "/sitemap.xml", "application/xml")).toBe(
      join(CLIENT, "sitemap.xml"),
    );
    expect(prerenderFile(CLIENT, "/a/feed.json", "application/json")).toBe(
      join(CLIENT, "a", "feed.json"),
    );
    expect(prerenderFile(CLIENT, "/docs/page.html", "text/html")).toBe(
      join(CLIENT, "docs", "page.html"),
    );
  });

  it("[DUSK-R2-5] an HTML page keeps the folder layout, a dotted name included, and the default stays index.html", () => {
    expect(prerenderFile(CLIENT, "/v1.2", "text/html")).toBe(join(CLIENT, "v1.2", "index.html"));
    expect(prerenderFile(CLIENT, "/about")).toBe(join(CLIENT, "about", "index.html"));
  });

  it("[DUSK-R2-5] the build writes /sitemap.xml and /robots.txt as files and /v1.2 as a page folder", async () => {
    const { entry: entryFile, clientDir } = fakeServer(SERVER);
    const done = await prerenderPages({
      entryFile,
      clientDir,
      targets: [
        { path: "/sitemap.xml", shell: false },
        { path: "/robots.txt", shell: false },
        { path: "/v1.2", shell: false },
        { path: "/docs/index.html", shell: false },
      ],
      options: {},
      base: "",
    });
    expect(done).toEqual(["/docs/index.html", "/robots.txt", "/sitemap.xml", "/v1.2"]);
    expect(readFileSync(join(clientDir, "sitemap.xml"), "utf8")).toBe("<body>/sitemap.xml</body>");
    expect(readFileSync(join(clientDir, "robots.txt"), "utf8")).toBe("<body>/robots.txt</body>");
    expect(existsSync(join(clientDir, "sitemap.xml", "index.html"))).toBe(false);
    expect(readFileSync(join(clientDir, "v1.2", "index.html"), "utf8")).toBe("<body>/v1.2</body>");
    expect(readFileSync(join(clientDir, "docs", "index.html"), "utf8")).toBe(
      "<body>/docs/index.html</body>",
    );
  });
});

describe("prerendered paths that differ only in case", () => {
  it("[DUSK-R2-5] two listed paths that differ only in case fail the build before anything is rendered", async () => {
    const { entry: entryFile, clientDir } = fakeServer(SERVER);
    const run = prerenderPages({
      entryFile,
      clientDir,
      targets: [
        { path: "/About", shell: false },
        { path: "/about", shell: false },
      ],
      options: { failOnError: false },
      base: "",
    });
    await expect(run).rejects.toThrow(PrerenderError);
    await expect(run).rejects.toThrow(/\/About.*\/about|\/about.*\/About/s);
    await expect(run).rejects.toThrow(/case/);
    expect(existsSync(clientDir)).toBe(false);
  });

  it("[DUSK-R2-5] a crawled link that collides in case with another page fails the build even with failOnError false", async () => {
    const { entry: entryFile, clientDir } = fakeServer(SERVER);
    await expect(
      prerenderPages({
        entryFile,
        clientDir,
        targets: [{ path: "/", shell: false }],
        options: { failOnError: false, crawlLinks: true },
        base: "",
      }),
    ).rejects.toThrow(/case/);
  });

  it("[DUSK-R2-5] the same path listed twice, or with and without a trailing slash, is not a collision", async () => {
    const { entry: entryFile, clientDir } = fakeServer(SERVER);
    const done = await prerenderPages({
      entryFile,
      clientDir,
      targets: [
        { path: "/a", shell: false },
        { path: "/a/", shell: false },
      ],
      options: {},
      base: "",
    });
    expect(done).toContain("/a");
  });
});
