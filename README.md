<p align="center"><img src="https://raw.githubusercontent.com/shadowjs-dev/dusk/main/.github/banner.png" alt="ShadowJS" width="100%"></p>

# @shadow-js/dusk

[![npm](https://img.shields.io/npm/v/@shadow-js/dusk.svg)](https://www.npmjs.com/package/@shadow-js/dusk)
[![CI](https://github.com/shadowjs-dev/dusk/actions/workflows/ci.yml/badge.svg)](https://github.com/shadowjs-dev/dusk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://github.com/shadowjs-dev/dusk/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

Dusk is the full-stack layer of ShadowJS: file-based routes, data loaders that run on the server for
the first request and in the browser afterward, server functions that the browser calls like local functions,
API routes, server rendering with streaming and hydration, and one request handler,
`fetch(Request) => Response`, with secure defaults (CSRF checks, secure headers, optional CSP with nonces,
cookies, sessions, rate limiting, request limits, environment validation). It builds on `@shadow-js/router`,
`@shadow-js/web` and Vite 7 or 8, and ships a Node server, a static prerenderer and a test client.

## Install

```sh
npm install @shadow-js/core @shadow-js/web @shadow-js/router @shadow-js/dusk
npm install -D vite typescript @types/node
```

Node 22.12 or newer. `@shadow-js/dusk` depends on `@shadow-js/vite`; `core`, `web` and `router` are peer
dependencies and Vite is an optional peer (`^8.0.0`, needed for development and builds). ShadowJS 1.0.0 is not
on npm yet. Until it is published, install the packages from a checkout of this repository. `npm run smoke:dusk`
in the repository packs the packages, creates an app, builds it, starts the production server and requests it.

## Quick start

An app is a Vite project with one plugin and a folder of route files:

```ts title="vite.config.ts" typecheck
import { dusk } from "@shadow-js/dusk/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [dusk()] });
```

```tsx title="src/routes/index.tsx" typecheck
import type { HeadTag, JSX } from "@shadow-js/web";

export const head = (): HeadTag[] => [{ tag: "title", children: "Home" }];

export default function Home(): JSX.Element {
  return <h1>Hello from Dusk</h1>;
}
```

`dusk dev` starts the dev server (server rendering with hot updates), `dusk build` writes `dist/client`,
`dist/server/entry.js` and `dist/dusk-manifest.json`, and `dusk start` serves that build with the Node adapter. To write
your own production server instead, it is a few lines:

```ts title="serve.ts" typecheck
import type { Handler } from "@shadow-js/dusk/server";
import { serve } from "@shadow-js/dusk/node";

// The server entry is a build output; it exports `handler` (and the same value as default).
const entry = (await import(new URL("./dist/server/entry.js", import.meta.url).href)) as {
  handler: Handler;
};

const server = await serve(entry.handler, {
  port: Number(process.env["PORT"] ?? 3000),
  host: "0.0.0.0",
  static: { dir: new URL("./dist/client/", import.meta.url).pathname },
});
console.log(`listening on ${server.url}`);
```

The handler that the build produces is an ordinary object, so it can be called without a server. This example
builds one by hand, from a route written in code, and calls it with the test client:

```tsx title="handler.tsx" run target="ssr" output="200 text/html; charset=utf-8\nHello from Dusk\nnosniff 404"
import { defineRoute } from "@shadow-js/router";
import { pages } from "@shadow-js/dusk/features/pages";
import { createHandler } from "@shadow-js/dusk/server";
import { createTestClient } from "@shadow-js/dusk/testing";

const home = defineRoute("/", { component: () => <h1>Hello from Dusk</h1> });

const handler = createHandler({
  features: [pages()],
  manifest: {
    routes: [home],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/client.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
  },
  security: { allowedHosts: ["localhost"] },
});

const client = createTestClient(handler);
const page = await client.get("/");
const html = await page.text();
console.log(page.status, page.headers.get("content-type"));
console.log(/<h1[^>]*>(?:<!--\[-->)?([^<]*)/.exec(html)?.[1]);
const missing = await client.get("/nope");
console.log(missing.headers.get("x-content-type-options"), missing.status);
```

## Command line

The package provides the `dusk` command:

- `dusk dev [--port <n>] [--host [<host>]] [--strictPort] [--open] [--verbose]` runs the development server on port 3000 with the app's `vite.config.*`, with a banner and one line per page or API request.
- `dusk build` writes the production output and prints a summary: the route table with each page's first-load JavaScript, and the budget warnings of `build.budgets`.
- `dusk start [--port <n>] [--host [<host>]] [--workers <n|auto>] [--log]` (alias `dusk preview`) runs the production build with the Node adapter. Run `dusk build` first, and add `dusk({ adapter: node() })` to `vite.config.ts`. `--workers` (or `DUSK_WORKERS`) runs that many server processes that share the port; see "Using every core" below.
- `dusk completion bash|zsh|fish` prints a shell completion script for the commands and flags (load it with `source <(dusk completion bash)`, `dusk completion fish | source`, or save the zsh script as `_dusk` on `$fpath`).
- `dusk doctor` checks the project (Node version, config, routes, env files, adapter, lockfile, duplicate packages) and exits 1 when a check fails.
- `dusk --help` and `dusk --version` print the usage and the version.
- `--json` (every command) prints JSON instead of words: one document for `build`, `doctor`, `completion`, `--help` and `--version`, JSON Lines for `dev` and `start`. See "Output for scripts" below.

### Output for scripts

With `--json`, stdout carries only JSON; the words (logs, warnings, the stack of an unexpected error) go to stderr, and the exit code is the same as without the flag. Every document has the same envelope:

```json
{
  "schema": 1,
  "command": "dusk build",
  "ok": true,
  "data": { "version": "1.0.0", "routes": [], "shared": { "files": 3 } },
  "warnings": [{ "code": "DUSK_BUDGET", "message": "/ is over its first-load budget" }]
}
```

`ok` is true exactly when the exit code is 0. A failure adds `error: { "code": "DUSK_...", "message": "..." }` and `data` keeps what is known; a refused command line (an unknown flag) is a document too, and so is an uncaught exception. `preview` is named `dusk start`.

| Command | `data` | `warnings` |
| --- | --- | --- |
| `dusk build` | the build summary: `version`, `steps`, `prerendered`, `secretScan`, `adapter`, `routes`, `shared`, `ms` | one `DUSK_BUDGET` per budget warning |
| `dusk doctor` | `checks` (`id`, `status`, `message`, `fix`); exit 1 and `DUSK_DOCTOR_FAILED` when one fails | one `DUSK_DOCTOR_<ID>` per `warn` check |
| `dusk completion <shell>` | `shell`, `script` | none |
| `dusk --help`, `dusk <command> --help`, `dusk --version` | `usage`, `version` | none |

`dusk dev --json` and `dusk start --json` keep running, so they print **JSON Lines**: one compact envelope per line, each with an `event` after `ok`. `ready` comes once the server listens (`data.url` is the address to open; `urls`, `port`, `mode`, `version`, `adapter`, `environments` and `readyMs` come with it), then a `request` line per page or API request (`method`, `path`, `status`, `ms`; with `dusk start` only under `--log`, and with `dusk dev` also the assets under `--verbose`), and `stopped` after a clean stop on SIGINT or SIGTERM. A line with `"ok": false` is the last one: it has no `event`, an `error`, and the exit code is 1.

```json
{"schema":1,"command":"dusk dev","ok":true,"event":"ready","data":{"url":"http://localhost:3000/","urls":{"local":["http://localhost:3000/"],"network":[]},"port":3000,"mode":"development","version":"1.0.0","adapter":null,"environments":[],"readyMs":812},"warnings":[]}
{"schema":1,"command":"dusk dev","ok":true,"event":"request","data":{"method":"GET","path":"/","status":200,"ms":41.2},"warnings":[]}
```

The error codes: `DUSK_UNKNOWN_COMMAND`, `DUSK_UNKNOWN_OPTION`, `DUSK_INVALID_OPTION`, `DUSK_INVALID_PORT`, `DUSK_INVALID_SHELL`, `DUSK_PORT_IN_USE`, `DUSK_NO_BUILD` (run `dusk build` first), `DUSK_NO_ADAPTER`, `DUSK_WRONG_ADAPTER`, `DUSK_BAD_BUILD`, `DUSK_BAD_MANIFEST`, `DUSK_NO_VERSION`, `DUSK_BUILD_FAILED`, `DUSK_BUDGET_EXCEEDED` (a page is over its budget and `budgets.enforce` is on), `DUSK_DOCTOR_FAILED`, `DUSK_FAILED` and `DUSK_UNEXPECTED`.

```bash
# The address of the dev server, for a script that opens it.
dusk dev --json | jq -r 'select(.event == "ready") | .data.url' | head -n 1
# Fail a CI step on a budget warning.
dusk build --json | jq -e '.warnings | length == 0' > /dev/null
# The checks that need attention.
dusk doctor --json | jq -r '.data.checks[] | select(.status != "ok") | "\(.id): \(.message)"'
```

## API

Eight entry points. The reference lists every export with its signature; the guides explain how they fit.

| Entry | Runs in | Contents |
| --- | --- | --- |
| `@shadow-js/dusk` | server and browser | `HttpError`, `isHttpError`, `redirect`, `notFound`, `isRedirect`, `isNotFound`, `redirectStatus` |
| `@shadow-js/dusk/server` | server | `createHandler`, `serverFn`, `apiRoute`, `apiHandler`, `getRequestEvent`, `createKey`, `defineEnv`, cookies (`createCookieSigner`), `createSessionManager`, `createRateLimiter`, `buildCsp`, `checkCsrf`, `json`, `readJson`, `timing` (your metrics for `Server-Timing`), and the types `Handler`, `RequestEvent`, `Middleware`, `HandlerOptions`, `SecurityOptions`, `ServerTimingOptions`, `RequestTimings`, `EventTiming`, `MetricsLike` |
| `@shadow-js/dusk/client` | browser | `hydrateDusk`, `serverFnStub`, `ServerFnError`, `ServerFnProtocolError` |
| `@shadow-js/dusk/node` | Node | `serve` (HTTP server, static files, brotli/zstd/gzip compression with `types` and a `filter`, `103 Early Hints`, graceful shutdown, and `workers` for a supervised pool of processes), `workerInfo`, `markProcessLocalStore`, `createFileKVStore`, `node()` adapter, and the types `ServerHandle`, `PoolControl`, `SuperviseOptions`, `WorkerInfo` |
| `@shadow-js/dusk/static` | Node | `prerender` (render pages to files, SPA shell, 404 page) |
| `@shadow-js/dusk/testing` | tests | `createTestClient`, `createTestEvent`, `createTestCookieJar` |
| `@shadow-js/dusk/auth` | server | `createOidcClient` (OAuth 2.1 / OpenID Connect authorization code flow with PKCE: discovery, ID token checks with WebCrypto, refresh, userinfo, RP-initiated logout), provider presets (`google`, `microsoft`, `auth0`, `okta`, `keycloak`, `github`, `discord`), `requireUser` guard, `verifyJwt`, `createJwksCache`, `OidcError` |
| `@shadow-js/dusk/stores/redis` | server | `redisStore` (the page cache over any Redis client, no Redis package needed), `RedisClient` |
| `@shadow-js/dusk/stores/contract` | tests | `runStoreContract`, `STORE_CONTRACT` (the scenarios every page cache store passes) |
| `@shadow-js/dusk/vite` | build time | `dusk` (the Vite plugin set), `transformServerFns`, `importProtection`, `fnId`, `defineFonts` (with per-route preloads and a size report), `pwa` (manifest, offline page and a generated service worker), `imageVariants` (AVIF and WebP files made at build time for `<Image>`) |
| `@shadow-js/dusk/features/pwa` | browser | `registerServiceWorker`, `useServiceWorkerUpdate`, `unregisterServiceWorker` (the page side of `pwa()`; opt-in) |
| `@shadow-js/dusk/bun` | Bun | `bun()` adapter, `serve` (`Bun.serve`, static files, gzip, graceful stop) |
| `@shadow-js/dusk/deno` | Deno | `deno()` adapter, `serve` (`Deno.serve`, the same rules as Bun) |
| `@shadow-js/dusk/cloudflare` | Workers | `cloudflare()` adapter (`worker.mjs`, `wrangler.toml`), `workerFetch` |
| `@shadow-js/dusk/vercel` | Vercel | `vercel()` adapter (Build Output API v3, Node.js or Edge function) |
| `@shadow-js/dusk/netlify` | Netlify | `netlify()` adapter (functions or edge functions, `_headers`, `_redirects`) |
| `@shadow-js/dusk/tarout` | Tarout | `tarout()` adapter (the Node layout with the `start` script Tarout runs) |

The adapters are passed to `dusk({ adapter })`; see the deployment guide, "Platforms".
| `@shadow-js/router/vite` | build time | The file-route scanner and tree generator that `dusk` uses |

WebSocket routes run on Node, Bun, Deno and Cloudflare Workers through the same `streams()` guards,
message limits and route callbacks. Bun exposes control frames to Dusk's ping/pong and rate checks.
Deno owns heartbeat framing and uses its native idle timeout; a separate `wsPongTimeoutMs` cannot be
configured there. Workers own control frames and do not expose a buffered-byte counter, so application
message and in-flight limits apply after native decoding. Bun's native payload ceiling and Workers'
platform ceiling can reject a message before Dusk sees it. Connections remain local to the running
server or Worker instance. Cloudflare close replies support older compatibility dates as well as the
[current native close behavior](https://developers.cloudflare.com/workers/runtime-apis/websockets/#close-behavior).

The local `smoke:bun`, `smoke:deno` and `smoke:cloudflare` commands build an app and check HTTP,
WebSocket echo, origin refusal and message limits against the actual runtimes. Bun and Deno also
check signal shutdown and the going-away close frame.

## Observability

Three opt-in tools, loaded only when used (a handler without them reads no clock and creates no span):

- `serverTiming` (handler option; on in development, off in production): the W3C `Server-Timing` header with `total`, `route`, `loaders`, `render` and the metrics you record with `event.timing.measure(name, fn)`; `{ header: false, onTimings }` feeds a hook instead of the response. A response with its own `Server-Timing` is left alone; names are validated tokens (at most 20 per request) and descriptions are reduced to safe ASCII.
- Child spans: with a `tracer` in `src/instrumentation.ts` (the OpenTelemetry `startActiveSpan` shape; no dependency), each request gets `dusk.request` with `http.request.method`, `url.path`, `http.response.status_code` and `http.route`, plus `dusk.loaders`, `dusk.loader`, `dusk.render`, `dusk.page.stream` and one span per endpoint (`dusk.page`, `dusk.api`, `dusk.rpc`). Every span ends exactly once, also on abort and timeout.
- `metrics` (handler option): an OpenTelemetry `Meter` (`createCounter().add`, `createHistogram().record`) receives `dusk.server.requests` and `http.server.request.duration` by route, method and status class.

The guide ([Configuring a Dusk app](https://shadowjs.net/guides/dusk-config/#observability)) has a complete OpenTelemetry SDK setup.

## Using every core

One Node process uses one core. `serve(handler, { workers: "auto" })`, `dusk start --workers auto` and `DUSK_WORKERS=4 node dist/node/server.mjs`
run one process per core (at most 16; or a number from 1 to 256) that share the port, with `node:cluster`. The first process is a primary that
serves nothing: it starts the workers and waits until each listens, replaces a worker that dies (after 0.5 s, doubling to 30 s), stops with
exit code 1 and a message when 5 workers crash within 30 s, replaces every worker one by one on `SIGUSR2` (a new worker is listening before
the old one drains, so requests keep succeeding), and on `SIGTERM` or `SIGINT` lets requests in flight finish for up to `gracefulShutdownMs`.
Without `workers`, or with `1`, the server is one process, as before. `supervise` tunes the delays, the breaker and the restart signal, and
`serve` returns a handle with `role` (`"single"`, `"worker"` or `"primary"`) and, in the primary, `pool` (`workers`, `pids()`, `restart()`, `failed`).

Memory is per worker: the page cache and the data cache over the in-memory store, sessions and rate limits kept in memory, and WebSocket
connections are one copy per worker, so give them a shared store (the primary warns once at start). In a container or under an orchestrator,
prefer one process per container and scale with replicas. The deploy guide's "Using every core" lists the platform differences (Windows, round
robin), what the primary logs, and when workers make sense.

## Scaling the page cache and the data cache

Concurrent requests for one uncached or stale page share one render (at most 1,000 requests per key, 10,000 keys; past a bound a request
renders on its own), and so do concurrent `cacheData` and `cachedFetch` calls for one key. A stale page is served at once while one
background render refreshes it, kept alive through the platform's `waitUntil` when there is one; a refresh that fails keeps the stale
page and backs off (1 s, doubling to 60 s). Pages answer with `Age` and a whole-lifetime `s-maxage`, so a CDN counts down to the same
moment the server does. For several instances, pass a shared store: `redisStore(client)` from `@shadow-js/dusk/stores/redis` over any
client with `get`, `set` with a millisecond expiry, `del`, `sAdd`, `sRem` and `sMembers`, and test your own store with
`runStoreContract` from `@shadow-js/dusk/stores/contract`. The configuration guide, "Scaling the caches", lists what each store
guarantees across instances.

The Vite plugin builds the server entry for you: it imports the generated route tree, the optional `src/app.tsx`
(root component) and `src/entry-server.ts` (handler options), registers the API routes and the server functions,
and exports `handler`. Without a plugin, `createHandler({ manifest, features, ...options })` takes the same pieces by hand,
with the features it serves (`features: [pages()]` for pages, `rpc()` for server functions, and so on).

## Typed server-function streams

An exported `serverFn({ stream: true }, handler)` can return an `AsyncIterable`. Input schemas,
guards, middleware, CSRF, deployment checks and request limits apply before delivery. The build
removes the generator from the browser and enables streaming RPC automatically. For a hand-built
handler, pass `rpc({ streams: {} })` from `@shadow-js/dusk/features/rpc`.

```ts typecheck
import { serverFn } from "@shadow-js/dusk/server";

export const ticks = serverFn({ stream: true }, async function* () {
  yield 1;
  yield 2;
});
```

In a component, `useStream(signal => ticks(undefined, { signal }))` from
`@shadow-js/dusk/client/stream` exposes `value()`, `status()`, `error()` and `reconnect()`.
Synchronous source reads are tracked. It keeps the latest item, aborts obsolete calls when inputs
change or the owner is disposed, and releases the iterator. Reconnect starts a fresh invocation;
there is no automatic retry or replay of mutations. Ordinary `for await` consumption is supported,
and breaking iteration cancels delivery.

The transport requests one item per consumer read. Defaults are 30 seconds and 10,000 items;
`rpc({ streams: { maxDurationMs, maxItems } })` can lower them or extend the deadline up to
2,147,483,647 ms. Frames are limited to 64 KiB and client transport chunks to 1 MiB. Streams cannot
use form posts, batches, single flight or custom cache-control. Production error frames preserve
the request id while hiding unexpected exception details. Generators waiting on external work
must observe the handler's `event.signal` to finish their own asynchronous cleanup promptly.

## Links

- [`@shadow-js/router`](https://router.shadowjs.net), [`@shadow-js/web`](https://shadowjs.net/reference/web/)
- [ShadowJS website](https://shadowjs.net)

## Dependencies

- Runtime `@shadow-js/query` `1.0.0`: hashes data-cache keys (`src/server/data-cache.ts`).
- Runtime `@shadow-js/vite` `1.0.0`: the Vite plugin the framework builds on (`src/vite/index.ts`).
- Runtime `acorn` `8.19.0`: parses modules for build checks (`src/adapter/checks.ts`).
- Runtime `magic-string` `^1.4.3`: edits code in the Vite plugin and server-function transform.
- Peers: `@shadow-js/core`, `@shadow-js/router`, and `@shadow-js/web` `^1.0.0`: the runtime, routing, and rendering the app uses.
- Optional peers: `@shadow-js/i18n` `^1.0.0` for locale routing (`src/i18n`) and `vite` `^8.0.0` for the dev server and build.
- Optional peers: `satori` `^0.43.0`, `@resvg/resvg-wasm` `^2.6.2`, `sharp` `^0.35.5`: renderers for Open Graph images (`src/og`).

## Types

- Server handlers: `HandlerOptions` and `Middleware` from `@shadow-js/dusk/server`. Server functions: `ServerFnError` from `@shadow-js/dusk/client`.
- Type tests in `test-types/` are compile-time checks of the public types.

## Support

- Node.js `>=22.12.0`. ESM only: use `import`; `require` is not supported.
- Browsers: current evergreen releases.
- Versioning: every `@shadow-js/*` package releases together at one version. Upgrade them as one set.
- Documentation: [ShadowJS documentation](https://shadowjs.net).

## Using, changing and contributing

- **Use the package** (a person or a coding agent that builds with it): this README, and [SKILL.md](SKILL.md), the short page an agent reads first.
- **Change the package** (fix a bug, add a feature): [AGENTS.md](AGENTS.md) says how the repository is laid out, how to implement and test a change, and how a pull request is reviewed. It is written for people and coding agents alike.
- **Take part**: [CONTRIBUTING.md](CONTRIBUTING.md) is the short guide; [SECURITY.md](SECURITY.md) is for vulnerabilities.
