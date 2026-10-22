import { describe, expect, it, vi } from "vitest";
import { errorDigest } from "../src/server/digest";
import { createHandler, type DuskHandler, type DuskRuntimeManifest } from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * Error UIs that show `error.digest`, with the message kept out of the page in production. `crash` throws while it
 * renders, `loaderBoom` fails in its loader, `other` throws a different message, and `wrapped` throws an error whose
 * root cause is the same as `crash`'s.
 */
const APP = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { HttpError } from "@start/server";

const crash = defineRoute("/crash", {
  id: "crash",
  component: () => { throw new Error("render exploded: secret database detail"); },
  error: ({ error }) => <p class="crash">{error.message} [{error.digest}]</p>,
});
const other = defineRoute("/other", {
  id: "other",
  component: () => { throw new Error("another failure"); },
  error: ({ error }) => <p class="other">{error.message} [{error.digest}]</p>,
});
const loaderBoom = defineRoute("/loader-boom", {
  id: "loader-boom",
  loader: () => { throw new Error("loader exploded: db"); },
  component: () => <p>never</p>,
  error: ({ error }) => <p class="loader">{error.message} [{error.digest}]</p>,
});
const layout = defineRoute("", {
  id: "layout",
  component: function Layout() {
    return <div class="layout"><Outlet /></div>;
  },
  children: [crash, other, loaderBoom],
});

export function App(props) {
  return <main class="app">{props.children}</main>;
}
export const routes = [layout];
`;

interface DigestApp {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
}

const ORIGIN = "http://localhost";

/** The digest an error UI shows: the text in `[...]` after its message, in the element of this class. */
function digestIn(html: string, cls: string): string | undefined {
  // The markers the server writes between adjacent text nodes carry no meaning here.
  const plain = html.replace(/<!--[^>]*-->/g, "");
  const match = new RegExp(`class="${cls}">[^\\[]*\\[([0-9a-f]+)\\]`).exec(plain);
  return match?.[1];
}

function manifestOf(app: DigestApp): DuskRuntimeManifest {
  return {
    routes: app.routes,
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
    App: app.App,
  };
}

/** A production handler (`dev: false`) on the localhost host. Without `onError`, its errors go to the default log. */
async function handlerOf(dev: boolean): Promise<DuskHandler> {
  const app = await load<DigestApp>(APP);
  return createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev,
    ...(dev ? {} : { security: { allowedHosts: ["localhost"] } }),
  });
}

/** The raw `console.error` calls since the last read, and clears them (the test asserts them). */
function takeCalls(): unknown[][] {
  const calls = vi.mocked(console.error).mock.calls.map((args) => [...args]);
  vi.mocked(console.error).mockClear();
  return calls;
}

/** The first line of each `console.error` call since the last read (the default log's header line). */
function takeLines(): string[] {
  return takeCalls().map((args) => String(args[0]));
}

describe("error digest: the code a production error page shows and the log line prints", () => {
  it("[DGST-01] a production render error shows its digest, and the log line of the same request prints the same digest", async () => {
    const handler = await handlerOf(false);
    const response = await handler.fetch(new Request(`${ORIGIN}/crash`));
    expect(response.status).toBe(500);
    const digest = digestIn(await response.text(), "crash");
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    const lines = takeLines().filter((line) => line.includes("render error"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`digest ${digest}`);
  });

  it("[DGST-02] the page never carries the raw message of a production error; the log keeps the error itself", async () => {
    const handler = await handlerOf(false);
    const html = await (await handler.fetch(new Request(`${ORIGIN}/crash`))).text();
    expect(html).not.toContain("secret database detail");
    expect(html).toContain("Internal Server Error");
    const calls = takeCalls();
    // The operator reads the message in the log, next to the digest.
    expect(calls.some((args) => String(args[1]).includes("secret database detail"))).toBe(true);
    expect(takeLines().some((line) => line.includes("secret database detail"))).toBe(false);
  });

  it("[DGST-03] a loader failure's digest is the digest of its log line", async () => {
    const handler = await handlerOf(false);
    const html = await (await handler.fetch(new Request(`${ORIGIN}/loader-boom`))).text();
    const digest = digestIn(html, "loader");
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    const lines = takeLines().filter((line) => line.includes("loader error"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.includes(`digest ${digest}`))).toBe(true);
  });

  it("[DGST-04] the same error has the same digest every time; a different error has another", async () => {
    const handler = await handlerOf(false);
    const first = digestIn(
      await (await handler.fetch(new Request(`${ORIGIN}/crash`))).text(),
      "crash",
    );
    const again = digestIn(
      await (await handler.fetch(new Request(`${ORIGIN}/crash`))).text(),
      "crash",
    );
    const other = digestIn(
      await (await handler.fetch(new Request(`${ORIGIN}/other`))).text(),
      "other",
    );
    takeCalls();
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(again).toBe(first);
    expect(other).toMatch(/^[0-9a-f]{8}$/);
    expect(other).not.toBe(first);
  });

  it("[DGST-05] an error wrapped in another error takes the digest of its root cause", () => {
    const root = new Error("render exploded: secret database detail");
    expect(errorDigest(new Error("outer", { cause: root }))).toBe(errorDigest(root));
  });

  it("[DGST-06] the digest is 8 hexadecimal characters and does not contain the message it stands for", () => {
    const digest = errorDigest(new Error("customer 4242 card declined"));
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    expect(digest).not.toContain("4242");
  });

  it("[DGST-07] in development the error UI shows the message itself, and the log line still carries the digest", async () => {
    const handler = await handlerOf(true);
    const html = await (await handler.fetch(new Request(`${ORIGIN}/crash`))).text();
    expect(html).toContain("render exploded: secret database detail");
    const lines = takeLines().filter((line) => line.includes("render error"));
    expect(lines.every((line) => /digest [0-9a-f]{8}\)/.test(line))).toBe(true);
  });
});
