import { describe, expect, it } from "vitest";
import { importProtection } from "../../src/vite/import-protection";

type Resolved = { id: string; external?: boolean } | null;

/** Runs the plugin's resolveId for a client import with a stubbed resolver. */
async function check(source: string, resolved: Resolved): Promise<string | undefined> {
  const plugin = importProtection(() => "/app", {});
  const hook = plugin.resolveId;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (handler === undefined) throw new Error("the plugin has no resolveId hook");
  let message: string | undefined;
  const context = {
    environment: { config: { consumer: "client" } },
    resolve: async () => resolved,
    error: (error: string | { message: string }) => {
      message = typeof error === "string" ? error : error.message;
      throw new Error(message);
    },
  };
  try {
    await Reflect.apply(handler, context, [source, "/app/src/routes/a.tsx", { ssr: false }]);
  } catch (error) {
    if (message === undefined) throw error;
  }
  return message;
}

describe("import protection review", () => {
  it("[DUSK-VITE-REV-12] a built-in name that resolves to an installed polyfill or an alias target is allowed in the browser", async () => {
    expect(await check("events", { id: "/app/node_modules/events/events.js" })).toBeUndefined();
    expect(await check("buffer", { id: "/app/src/shims/buffer.ts" })).toBeUndefined();
  });

  it("[DUSK-VITE-REV-12] a built-in name that resolves to Vite's browser stand-in, or to nothing, is still refused", async () => {
    expect(await check("fs", { id: "__vite-browser-external:fs" })).toMatch(/Node built-in "fs"/);
    expect(await check("path", { id: "\0__vite-browser-external:path" })).toMatch(
      /built-in "path"/,
    );
    expect(await check("os", null)).toMatch(/built-in "os"/);
    expect(await check("crypto", { id: "crypto", external: true })).toMatch(/built-in "crypto"/);
  });

  it("[DUSK-VITE-REV-12] the node: prefix is always the Node module", async () => {
    expect(await check("node:events", { id: "/app/node_modules/events/events.js" })).toMatch(
      /Node built-in "node:events"/,
    );
  });
});
