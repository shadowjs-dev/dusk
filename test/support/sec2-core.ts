import type { DuskRuntimeManifest } from "../../src/server/index";

/** One API route of a hand-made manifest. */
export interface ApiEntry {
  readonly id: string;
  readonly path: string;
  readonly module: unknown;
}

/**
 * A manifest with API routes, server functions and stream routes built by hand, so a test of the request path needs
 * neither the compiler nor the shared app. The server functions are loaded lazily, like the build's.
 */
export function handmade(
  apis: readonly ApiEntry[] = [],
  fns: Readonly<Record<string, unknown>> = {},
  streams: DuskRuntimeManifest["streams"] = [],
): DuskRuntimeManifest {
  return {
    routes: [],
    apiRoutes: apis.map((api) => ({
      id: api.id,
      path: api.path,
      load: async () => api.module as never,
    })),
    serverFns: Object.fromEntries(
      Object.entries(fns).map(([id, definition]) => [
        id,
        { load: async () => definition as never },
      ]),
    ),
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
    ...(streams === undefined ? {} : { streams }),
  };
}

/** A GET request to the local test host. */
export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

/** A same-origin POST (the CSRF check passes), JSON by default. */
export function post(
  path: string,
  body: BodyInit,
  headers: Record<string, string> = { "content-type": "application/json" },
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body,
    headers: { origin: "http://localhost", ...headers },
  });
}
