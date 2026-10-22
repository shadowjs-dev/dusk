import { expect, it } from "vitest";
import { transformServerFns } from "../../src/vite/server-fn";

const code = `import { serverFn } from "@shadow-js/dusk/server";
export const ticks = serverFn({ stream: true }, async function* () { yield "server secret"; });
export const ordinary = serverFn({}, () => 1);`;
const input = { code, file: "/app/src/functions.ts", root: "/app", base: "/app" };

it("[RPC-STREAM-BUILD-01] the browser receives a streaming stub and no generator implementation", () => {
  const result = transformServerFns({ ...input, target: "client" });
  expect(result?.code).toContain("@shadow-js/dusk/client/stream");
  expect(result?.code).toContain("serverStreamStub");
  expect(result?.code).toContain("serverFnStub");
  expect(result?.code).not.toContain("server secret");
  expect(result?.fns.find((fn) => fn.exportName === "ticks")).toMatchObject({
    stream: true,
    batch: false,
  });
  expect(result?.fns.find((fn) => fn.exportName === "ordinary")?.stream).not.toBe(true);
});

it.each([
  "stream: flag",
  "stream: true, batch: true",
  "stream: true, form: true",
  "stream: true, singleFlight: true",
])(
  "[RPC-STREAM-BUILD-02] incompatible or nonliteral stream options fail before bundling (%s)",
  (options) => {
    expect(() =>
      transformServerFns({
        ...input,
        code: code.replace("stream: true", options),
        target: "client",
      }),
    ).toThrow();
  },
);
