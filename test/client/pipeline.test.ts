import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNotFound, isRedirect } from "@shadow-js/router/core";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/internal/http-error";
import {
  createHandler,
  type DuskRuntimeManifest,
  type ServerFnDefinition,
} from "../../src/server/index";
import { type ServerFnInfo, transformServerFns } from "../../src/vite/server-fn";
import { allFeatures } from "../support/features";
import { browserFetch, serve, type TestServer } from "./support/http";

/**
 * The transform's output is run, not just compared: the server variant of a module becomes the
 * server's registry, the client variant of the same module is called from the "browser", and
 * the two meet over a real socket under the ids the transform computed.
 */

const SERVER_ENTRY = pathToFileURL(
  fileURLToPath(new URL("../../src/server/index.ts", import.meta.url)),
).href;
const CLIENT_ENTRY = pathToFileURL(
  fileURLToPath(new URL("../../src/client/index.ts", import.meta.url)),
).href;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const MODULE = [
  `import { HttpError, redirect, serverFn } from "@shadow-js/dusk/server";`,
  ``,
  `const SECRET = "SECRET_PIPELINE_VALUE";`,
  `const double = (n: number): number => n * 2;`,
  ``,
  `export const twice = serverFn({}, async (input: unknown) => ({ value: double(Number(input)), secret: SECRET.length }));`,
  `export const lookup = serverFn({ method: "GET" }, async (input: unknown) => ({ id: String(input), found: true }));`,
  `export const guarded = serverFn({}, async () => { throw new HttpError(403, "no entry", { data: { code: 7 } }); });`,
  `export const leave = serverFn({}, async () => { throw redirect("/elsewhere", { status: 303 }); });`,
  `export async function sum(input: unknown): Promise<number> {`,
  `  "use server";`,
  `  return (input as number[]).reduce((a, b) => a + b, 0);`,
  `}`,
  `export function makeGreeter(prefix: string) {`,
  `  return async function greet(name: string): Promise<string> {`,
  `    "use server";`,
  `    return \`\${double(1)}:\${name}\`;`,
  `  };`,
  `}`,
  ``,
].join("\n");

interface Loaded {
  readonly server: Record<string, unknown>;
  readonly client: Record<string, unknown>;
  readonly fns: readonly ServerFnInfo[];
  readonly clientCode: string;
}

async function load(source: string): Promise<Loaded> {
  const dir = mkdtempSync(join(tmpdir(), "shadow-pipeline-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"), { recursive: true });
  const file = join(dir, "src", "api.ts");
  const server = transformServerFns({ code: source, file, root: dir, target: "server" });
  const client = transformServerFns({ code: source, file, root: dir, target: "client" });
  if (server === null || client === null) throw new Error("no server functions");
  writeFileSync(
    join(dir, "src", "api.server.mjs.ts"),
    server.code.replace('"@shadow-js/dusk/server"', JSON.stringify(SERVER_ENTRY)),
  );
  writeFileSync(
    join(dir, "src", "api.client.mjs.ts"),
    client.code.replace('"@shadow-js/dusk/client"', JSON.stringify(CLIENT_ENTRY)),
  );
  return {
    server: (await import(
      /* @vite-ignore */ pathToFileURL(join(dir, "src", "api.server.mjs.ts")).href
    )) as Record<string, unknown>,
    client: (await import(
      /* @vite-ignore */ pathToFileURL(join(dir, "src", "api.client.mjs.ts")).href
    )) as Record<string, unknown>,
    fns: server.fns,
    clientCode: client.code,
  };
}

async function connect(loaded: Loaded): Promise<{ origin: string; server: TestServer }> {
  const serverFns: DuskRuntimeManifest["serverFns"] = Object.fromEntries(
    loaded.fns.map((fn) => [
      fn.id,
      {
        load: async (): Promise<ServerFnDefinition> =>
          loaded.server[fn.exportName] as ServerFnDefinition,
      },
    ]),
  );
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns,
      assets: { entry: "", css: [], preloads: {}, base: "/" },
      App: ({ children }: { children?: unknown }) => children,
    },
    dev: true,
    onError: () => undefined,
  });
  const server = await serve((request) => handler.fetch(request));
  cleanups.push(() => server.close());
  return { origin: server.origin, server };
}

type Callable = { with(options: { fetch: typeof fetch }): (input?: unknown) => Promise<unknown> };

describe("transform -> run: both variants of one module", () => {
  it("[SPIPE-01] the client variant calls the server variant under the computed ids", async () => {
    const loaded = await load(MODULE);
    const { origin } = await connect(loaded);
    const call = (name: string): ((input?: unknown) => Promise<unknown>) =>
      (loaded.client[name] as Callable).with({ fetch: browserFetch(origin) });

    expect(await call("twice")(21)).toEqual({ value: 42, secret: "SECRET_PIPELINE_VALUE".length });
    expect(await call("lookup")("abc")).toEqual({ id: "abc", found: true });
    expect(await call("sum")([1, 2, 3, 4])).toBe(10);

    const denied = await call("guarded")().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(denied).toBeInstanceOf(HttpError);
    expect((denied as HttpError).data).toEqual({ code: 7 });

    const left = await call("leave")().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isRedirect(left)).toBe(true);
    expect(isNotFound(left)).toBe(false);
  });

  it("[SPIPE-02] a hoisted inline function is registered under $$server_n and works from the client stub", async () => {
    const loaded = await load(MODULE);
    expect(loaded.fns.map((fn) => fn.exportName)).toContain("$$server_0");
    const hoisted = loaded.server["$$server_0"];
    expect(typeof hoisted).toBe("function");
    const { origin } = await connect(loaded);
    // The client module reaches the hoisted function through makeGreeter(): it returns the stub.
    const greet = (loaded.client["makeGreeter"] as (prefix: string) => Callable)("x");
    expect(await greet.with({ fetch: browserFetch(origin) })("Ann")).toBe("2:Ann");
  });

  it("[SPIPE-03] the client variant contains no server text, and the server variant keeps it", async () => {
    const loaded = await load(MODULE);
    expect(loaded.clientCode).not.toContain("SECRET_PIPELINE_VALUE");
    expect(loaded.clientCode).not.toContain("double");
    expect(loaded.clientCode).not.toContain("reduce");
    expect(loaded.clientCode).not.toContain("@shadow-js/dusk/server");
    expect(Object.keys(loaded.server).sort()).toEqual(
      ["$$server_0", "guarded", "leave", "lookup", "makeGreeter", "sum", "twice"].sort(),
    );
  });
});
