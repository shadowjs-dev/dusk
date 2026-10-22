import { defineRoute, type RouteDefinition } from "@shadow-js/router";
import { isRedirect } from "@shadow-js/router/core";
import { describe, expect, it } from "vitest";
import { gateServerNavigations, NavigationRefusedError } from "../../src/client/server-gate";

/** A fake `fetch` that records the requests and answers with `answer`. */
function fakeFetch(answer: () => Response) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    requests.push({ url: input, init });
    return answer();
  };
  return { fetch, requests };
}

const LOCATION = { pathname: "/admin/users", search: "", hash: "" };

/** Where the page would leave the app to (the default is `location.replace`). */
const left: string[] = [];
const leave = (href: string): void => {
  left.push(href);
};

/** The route's own `beforeLoad`, called the way the router calls it. */
async function runBeforeLoad(route: RouteDefinition): Promise<unknown> {
  const beforeLoad = route.spec.beforeLoad;
  if (beforeLoad === undefined) throw new Error("no beforeLoad");
  return beforeLoad({
    params: {},
    search: {},
    context: {},
    location: LOCATION,
    intent: "enter",
    signal: new AbortController().signal,
  } as never);
}

function gatedTree(original: () => unknown): RouteDefinition[] {
  const layout = defineRoute("/admin", {
    id: "/admin/_layout",
    beforeLoad: original as never,
    children: [defineRoute("/users", { id: "/admin/users" })],
  });
  // A route that runs server middleware: the flag the generated tree sets.
  const marked = { ...layout, spec: { ...layout.spec, serverMiddleware: true } };
  return [marked];
}

describe("server navigation gate (browser side)", () => {
  it("[GATE-1] a tree without server middleware is returned unchanged and nothing is fetched", async () => {
    const routes = [defineRoute("/", { id: "/" })];
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 204 }));
    const gated = gateServerNavigations(routes, {
      base: "",
      origin: "http://app.test",
      fetch,
      leave,
    });
    expect(gated[0]).toBe(routes[0]);
    expect(requests).toEqual([]);
  });

  it("[GATE-2] an allowed navigation asks the server with the app path, then runs the route's own beforeLoad", async () => {
    let ran = 0;
    const { fetch, requests } = fakeFetch(
      () => new Response(null, { status: 204, headers: { "x-dusk-gate": "allowed" } }),
    );
    const [route] = gateServerNavigations(
      gatedTree(() => {
        ran += 1;
        return { user: "ada" };
      }),
      { base: "/app", origin: "http://app.test", fetch, leave },
    );
    if (route === undefined) throw new Error("no route");
    expect(await runBeforeLoad(route)).toEqual({ user: "ada" });
    expect(ran).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/app/_dusk/nav");
    expect(requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      path: "/admin/users",
      search: "",
    });
    expect(new Headers(requests[0]?.init.headers).get("x-dusk-navigation")).toBe("check");
  });

  it("[GATE-3] a refusal throws NavigationRefusedError with the status and runs nothing else", async () => {
    let ran = 0;
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ status: 401 }), {
          status: 200,
          headers: { "content-type": "application/json", "x-dusk-gate": "refused" },
        }),
    );
    const [route] = gateServerNavigations(
      gatedTree(() => {
        ran += 1;
        return undefined;
      }),
      { base: "", origin: "http://app.test", fetch, leave },
    );
    if (route === undefined) throw new Error("no route");
    const error = await runBeforeLoad(route).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NavigationRefusedError);
    expect((error as NavigationRefusedError).status).toBe(401);
    expect(ran).toBe(0);
  });

  it("[GATE-4] a same-origin redirect becomes the router's redirect to the app path, without the mount base", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ status: 302, redirect: "/app/login?from=users" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-dusk-gate": "refused" },
        }),
    );
    const [route] = gateServerNavigations(
      gatedTree(() => undefined),
      {
        base: "/app",
        origin: "http://app.test",
        fetch,
        leave,
      },
    );
    if (route === undefined) throw new Error("no route");
    const error = await runBeforeLoad(route).catch((thrown: unknown) => thrown);
    expect(isRedirect(error)).toBe(true);
    expect((error as { to: string }).to).toBe("/login?from=users");
  });

  it("[GATE-5] a redirect to another origin leaves the app for it, as a document redirect does; the navigation stays pending", async () => {
    left.length = 0;
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ status: 302, redirect: "https://sso.example/login" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-dusk-gate": "refused" },
        }),
    );
    const [route] = gateServerNavigations(
      gatedTree(() => undefined),
      { base: "", origin: "http://app.test", fetch, leave },
    );
    if (route === undefined) throw new Error("no route");
    let settled = false;
    void runBeforeLoad(route).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(left).toEqual(["https://sso.example/login"]);
    expect(settled).toBe(false);
  });

  it("[GATE-8] the query string of the target is sent with the path, and the gate sees it as the target", async () => {
    const { fetch, requests } = fakeFetch(
      () => new Response(null, { status: 204, headers: { "x-dusk-gate": "allowed" } }),
    );
    const [route] = gateServerNavigations(
      gatedTree(() => undefined),
      { base: "/app", origin: "http://app.test", fetch, leave },
    );
    if (route === undefined) throw new Error("no route");
    const beforeLoad = route.spec.beforeLoad;
    if (beforeLoad === undefined) throw new Error("no beforeLoad");
    await beforeLoad({
      params: {},
      search: {},
      context: {},
      location: { pathname: "/admin/users", search: "?page=2&q=a", hash: "" },
      intent: "enter",
      signal: new AbortController().signal,
    } as never);
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      path: "/admin/users",
      search: "?page=2&q=a",
    });
  });

  it("[GATE-6] an answer that is not the gate's (no marker, not JSON) refuses with the response status", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>proxy page</html>", { status: 502 }));
    const [route] = gateServerNavigations(
      gatedTree(() => undefined),
      {
        base: "",
        origin: "http://app.test",
        fetch,
        leave,
      },
    );
    if (route === undefined) throw new Error("no route");
    const error = await runBeforeLoad(route).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NavigationRefusedError);
    expect((error as NavigationRefusedError).status).toBe(502);
  });

  it("[GATE-7] a 204 without the allowed marker is not an allowance", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const [route] = gateServerNavigations(
      gatedTree(() => undefined),
      {
        base: "",
        origin: "http://app.test",
        fetch,
        leave,
      },
    );
    if (route === undefined) throw new Error("no route");
    const error = await runBeforeLoad(route).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NavigationRefusedError);
  });
});
