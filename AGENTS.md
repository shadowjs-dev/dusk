# AGENTS.md: working on dusk

This file is for anyone who changes this repository, people and coding agents alike. It says how the repository is laid out, how to implement
and test a change, and how a pull request is reviewed. To **use** the released package, read [README.md](README.md) and [SKILL.md](SKILL.md)
instead; to take part in the project, read [CONTRIBUTING.md](CONTRIBUTING.md).

The full-stack framework: file routes, server functions, streaming and adapters for Node, Bun, Deno, Cloudflare, Vercel, Netlify and static export.

## What is in this repository

| Package | Folder | What it is | Documentation |
| --- | --- | --- | --- |
| `@shadow-js/dusk` | `.` | A full-stack framework with file routes, loaders, server functions and secure request handling | https://dusk.shadowjs.net |

The repository is the package: `@shadow-js/dusk`. Source and issues:
https://github.com/shadowjs-dev/dusk. Every package of the project has the same version number.

## Set up

You need Node.js 22.12 or newer and npm (pnpm and Yarn are not used).

The tests also need:

- `bun`: the tests run against it.
- `deno`: the tests run against it.
- `wrangler`: the tests run against it.

A test whose tool or account is missing **fails** with instructions; it is never skipped.

```sh
npm install
npm run check   # lint, build, type check and every test
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run lint` | Biome: lint and format check (`npx biome check --write <path>` fixes what it can) |
| `npm run build` | builds the package with tsdown |
| `npm run typecheck` | TypeScript 7 in strict mode, tests included |
| `npm test` | unit, DOM and server tests (Vitest) |
| `npx vitest run <path>` | one test file |
| `npm run test:gc` | memory and leak tests |
| `npm run test:perf` | wall-clock budgets; run alone, never in parallel with other work |
| `npm run check` | all of the above; a change is ready when it passes |

## Layout

- `.github/`: workflows, issue and pull request templates, code owners.
- `build/`: the shared tsdown preset every package build uses.
- `scripts/`: build and release scripts; `release.mjs` is run by the workflows.
- `src/`: the source of the package; one folder per concern, `index.ts` re-exports the public API. Folders: `adapter/`, `auth/`, `bun/`, `cli/`, `client/`, `cloudflare/`, `components/`, `deno/`, `features/`, `i18n/`, `internal/`, `metadata/`, `netlify/`, `node/`, `og/`, `server/`, `shared/`, `static/`, `tarout/`, `testing/`, `vercel/`, `vite/`.
- `test/`: the tests; one file per behavior, each test named by an invariant id such as `[ROUTER-12]`.
- `test-types/`: type-level tests: what the package promises to the compiler of its users.
- `types/`: ambient declarations shared with the build.
- `CHANGELOG.md`: what each release changed.
- `biome.json`: lint and format rules.
- `package.json`: the manifest; `version` is changed only by a release.
- `tsconfig.json`: type check of the source.
- `tsconfig.test-types.json`: type check of `test-types/`.
- `tsdown.config.mjs`: the build.
- `vitest.config.ts`: the test projects (unit, DOM, server, gc, perf).
- `vitest.setup.ts`: test setup: an unasserted `console.warn` or `console.error` fails a test.

## How to implement a change

1. **Find where the behavior lives.** Search `test/` and `src/` for the name of the behavior or its invariant id, then read the source the tests exercise. The invariants below say what must stay true.
2. **Write the failing test first.** A bug fix reproduces the bug; a feature states the behavior it promises. Name the test with an invariant id in square brackets, the way the neighboring tests do, then the behavior in words. The test asserts what the code does and is never skipped, marked as todo or marked as an expected failure.
3. **Make it pass with the smallest change** that keeps the invariants. Match the code around it.
4. **Keep the surface honest.** A public symbol has TSDoc (summary, parameters, return value, an example and `@since`). An error says what happened and how to fix it. User-visible behavior gets a documentation update and a line under `## Unreleased` in CHANGELOG.md.
5. **Run `npm run check`** and read its output; do not report a change as done without it passing.

### Rules every change keeps

- No `any`, `@ts-ignore` or non-null assertion. Use `unknown` and narrow.
- Compare indices, lengths and counts explicitly (`=== undefined`, `=== -1`, `> 0`), never by truthiness.
- No empty `catch`: every catch rethrows, passes the error to the owner's handler, or reports it. Every "set the current X" register is restored in `finally`.
- User callbacks run untracked unless the API says otherwise. No stack parsing, no `fn.name` sniffing, no flags stamped on user functions.
- Traversals whose depth the user controls are iterative. Caches, queues and recursion are bounded, and a test hits the bound.
- Code meant for development only sits behind `__DEV__`. No import-time side effects and no module-level mutable state beyond the registers the core owns (bounded caches and `WeakMap`s excepted).
- No sleeps in tests (flush the scheduler); a `console.warn` or `console.error` that a test does not assert fails the test. Property tests use `fast-check` with a fixed seed.
- Files are kebab-case, tests are `*.test.ts`, internals live in `src/internal/`. American English in code, comments and documentation. Comments explain why, not what.
- The reactive core and the DOM renderer have no runtime dependencies.

## Pull requests

1. **Open an issue first** for anything that adds or changes public API, behavior, supported platforms or dependencies. A small fix needs no issue.
2. **Fork, then branch from `main`** (`fix/<topic>`, `feat/<topic>`, `docs/<topic>`). One concern per pull request.
3. **Commit in small steps** with a message that says what changed and why: a short type prefix (`fix:`, `feat:`, `docs:`, `test:`, `chore:`), then the subject. Commit under your own identity; do not add trailers or notes about tools.
4. **Open the pull request against `main`** and fill in the template: what changes, why, and the checks you ran. The CI workflow (`.github/workflows/ci.yml`) runs lint, build, type check and all tests; it must be green.
5. **Review.** A maintainer (see `.github/CODEOWNERS`) reviews every pull request. Expect questions about the test, the public surface and the error messages. Push fixes to the same branch; the pull request is squash-merged.
6. **Releases are not part of a pull request.** Do not change `version`, `.github/workflows/release.yml` or `scripts/release.mjs`, and do not create tags or publish. A maintainer releases by renaming `## Unreleased` in the changelog to the version and pushing a version that is not yet on npm to `main`; the workflow publishes it with provenance.

Security problems never go in a public issue or pull request: follow [SECURITY.md](SECURITY.md).

## Architecture and invariants

What each package keeps true. A change that breaks one of these is a bug in the change.

The invariants of the package. A change that breaks one must update the code and the tests that check it together.

### Server runtime (`src/server`, `src/node`, `src/testing`, `src/static`)
- One contract: `createHandler(...).fetch(Request, platform?) => Response`. Adapters only bridge; nothing under
  `src/server` imports `node:*` (the async context is found through `process.getBuiltinModule`).
- Nothing user-written runs for a rejected request: guards (URL, host, framing, body size) and CSRF come
  before middleware. CSRF is on by default for every state-changing method, including API routes and RPC.
- Every cache, queue and list has a bound and a test that hits it: cookies (header, count, size, outgoing),
  validation issues, GET payload, RPC response, hydration payload, `Link` header, CSP header, session store,
  rate-limit store, compressor concurrency, prerender pages/size, `Accept-Encoding`.
- Unexpected errors never reach a client in production: the message is the reason phrase, details go to
  `onError` (once per error). Client errors (`HttpError` 4xx) expose their message.
- Redirect targets pass `checkRedirectTarget` (no `//host`, backslashes, control characters, foreign origins).
- Static file paths are decoded once, checked for dot segments / NUL / backslash, then resolved with
  `realpath` below the real directory. Tests send raw request lines (`..%2f`, `%00`, symlinks).
- Every layer that answers a file (the Node static layer, the Bun and Deno layer) applies the handler's host list
  (`hostCheckOf`, the same predicate the handler uses) before it reads the disk: a refused Host goes to the handler, which
  answers its own 400, so a file and a missing path look alike. Platform routes (Vercel, Cloudflare) enforce the same list
  through `adapter/host-routes.ts`, whose expression is pinned to `compileHostRules` by `RE-*` tests.
- No module-level mutable state; the only module value is the `AsyncLocalStorage` (a free function
  `getRequestEvent()` needs one) and `WeakMap`/`WeakSet` keyed by request objects.
- `await next()` in middleware always resolves with a `Response`: failures inside the chain are mapped to responses by the
  handler's failure mapper (`failure.ts`) before the middleware sees them. Never let a route error escape `next()` as a
  rejection, and never run middleware for a request the guards or CSRF refused.
- One redirect rule for every path (`checkRedirectTarget` on the target as written), pinned by the table in
  `redirect-targets.server.test.ts`: a new place that emits a redirect joins that table.
- Test helpers (`src/testing`) must keep working under happy-dom: they re-apply the headers a browser-like `Request` drops
  and never weaken the handler's checks.
- The generated server entry must build without bundler warnings for every `entry-server.ts` shape (`build.test.ts`,
  `SBLD-40`/`SBLD-41`).

### Runtime features (`src/server/isr.ts`, `sse.ts`, `websocket.ts`, `ws-protocol.ts`, `rpc.ts`, `image-route.ts`, `src/shared`, `src/client/streams.ts`, `islands.ts`)
- Every cache is bounded: the memory `CacheStore` (LRU by entries), the in-flight renders (`cache.maxInFlight`), the tags of a response (64), the SSE buffer (`streams.sseMaxBufferedEvents`), the event log (its capacity), the batch (`rpc.maxBatchSize`) and its response budget.
- A cached answer is only ever for a request that carries no `Authorization` and no cookie the page does not declare; a `Set-Cookie` answer is never stored, and an error is never stored.
- A WebSocket upgrade is decided before a socket exists (`handler.upgrade`): the guards, the handshake, the origin and the route's refusal run in that order. The frame reader refuses an oversized message from its header, before buffering it.
- SSE and WebSocket failures end their own stream; they never reach another connection. A handler error on a stream is reported once unless the client went away.
- Image sources are an allow-list: a local path only through the app's `source`, a remote image only from `remotePatterns`, never a redirect.
- Islands and the client streams are plain DOM and fetch code: they must run with no `document` in Node until they are called (`hydrateIslands` reads the DOM only when called).

### Request context (`src/server/route-middleware.ts`, `guard.ts`, `locals.ts`, `src/client/server-gate.ts`)
- Route and folder middleware (`middleware` exports, `_middleware` files) is server-only: the route tree and the browser copy
  never import it (the router's client transform strips the export). The browser asks `POST {base}/_dusk/nav` before it loads a
  top-level route whose subtree runs middleware; a test pins that the answer is a 204 marker or a JSON refusal, never a redirect
  the browser must follow.
- A page whose chain runs middleware is never answered from the ISR cache (`hasPageMiddleware`).
- Guards run before input validation, before the function's middleware and before the handler; a refusal runs none of them.
- `event.locals` is per request and is never serialized by the framework. A test pins that a locals value does not reach the page,
  the router payload or an API answer.

### Configuration, storage and the request lifecycle (`src/shared`, `src/vite/config-file.ts`, `src/server/kv-*`, `data-cache.ts`, `routing.ts`, `after.ts`, `draft-mode.ts`, `instrumentation.ts`, `cache-control.ts`, `deployment.ts`, `cors.ts`)
- Secrets never belong in `dusk.config.ts`: the server part of the file is written into the server bundle as plain JSON. `security.cookieSecrets` is refused and a function in that part is a build error with its path (`bakeServerConfig`).
- The configuration is validated twice with the same code: at build time (`validateDuskConfig`, `validateRouting`) and at server start (`createHandler` through `serverOptionsFromConfig`). A key that is not known is an error with a suggestion, never ignored.
- Every store speaks the `KVStore` contract and passes `KV_CONFORMANCE` (`@shadow-js/dusk/testing`). Values are JSON, stored as copies. The memory store is bounded (`maxEntries`, `maxValueBytes`); the file store lives in `src/node` (nothing under `src/server` imports `node:*`).
- Every cache, queue and tag list has a bound and a test that hits it: the data cache (`maxInFlight`, `maxValueBytes`, `maxKeysPerTag`), the KV tag index (`maxKeysPerTag`), the tags of an entry (16), the `after()` queue (32). Path patterns are matched in linear time (no regular expression is built from a user pattern).
- A redirect target always passes `checkRedirectTarget`; a rewrite destination is a path of this app and never under `/_dusk/`; a config redirect to a foreign origin must be listed in `security.trustedOrigins`.
- Draft mode: the secret comes from the environment only, never from a URL; the enable and disable endpoints are POST and CSRF-checked; the cookie is signed with a signer of the draft secret; while draft mode is on, the page cache and `cacheData` read and write nothing.
- `cachedFetch` refuses `authorization`, `cookie` and `proxy-authorization` headers (a shared cache never holds one user's answer). A `public` cache-control becomes `private` for a request with cookies or authorization, and a POST function cannot be `public`.
- `after()` tasks and the instrumentation hooks never change a response and never stop the process: a failure goes to `onRequestError` (phase `after` or `instrumentation`) or to the log.
- The deployment id is compared only when the request carries the header; a mismatch is `409 DEPLOYMENT_MISMATCH` before the function runs. The fingerprint that stands in for an unset id is a function of the sources only, so builds stay byte-identical.

### Metadata, metadata routes, images and fonts (`src/metadata`, `src/server/metadata-routes.ts`, `src/og`, `src/vite/fonts.ts`)
- The chain is merged outermost first by `mergeMetadata`; a string title takes the nearest template, `absolute` skips it, `null` removes. A test pins each rule (`MD-MERGE-*`).
- Every metadata URL goes through `resolveMetadataUrl`: only http(s) (and, for app links only, custom schemes that are not `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`); no protocol-relative values; no control characters; at most 2048 characters.
- JSON-LD is never a head tag (the head refuses `script`): it is written by the document shell with the request nonce, and `jsonLdText` escapes `<`, `>`, `&` and the line separators.
- Route `headers` may not set `content-length`, `content-type`, `link`, `location` or `set-cookie`; a refused name is reported (phase `head`).
- The server resolves the chain before the render (an async `generateMetadata` is awaited there); the client applies the leaf's chain through the `metadata` capability, which does nothing on the server.
- Sitemaps, robots and manifests are checked before a byte is written (URL count, file size, date form, priority range, line breaks); the response helpers take the request event, so the answer can depend on the host.
- `ImageResponse` checks its size and its tree before any drawing (node and depth limits). satori is loaded through a runtime specifier so its React-typed declarations are not needed; both optional peers are loaded only when an image is drawn.
- `defineFonts` only reads files under `public/` and refuses any path that could leave it; it never downloads.

### Components, response, images, fonts and conventions (`src/components`, `src/shared/response.ts`, `src/server/image-*`, `src/vite/google-fonts.ts`, `src/vite/conventions.ts`)
- The request context lives in `src/internal/request-context.ts` (re-exported by `src/server/context.ts`): client-reachable code (`useResponse`, the components) may read the event, and `src/server` may not be imported from there (the import protection fails the build).
- `useResponse()` writes only through the event's own response fields; a write after the commit point (the shell of a streamed page, or the response of a whole-page render) is ignored in development with a warning. Refused headers are typed `TypeError`s on every side.
- A component module is compiled by the tsdown `.tsx` plugin (dom for the browser builds, ssr for `dist/server`), and its markup must match between the two (hydration claims the server's elements). The components' server path runs only in the node environment: test the head and the script markup in `*.server.test.ts`.
- Every image candidate is an entry of `IMAGE_WIDTHS`, and the optimizer checks width, quality and format against the allow-lists before the source is read. `sharp` is loaded through a non-literal specifier; a missing install is an error that names it.
- Google Fonts: only `https://fonts.googleapis.com/css2` and files on `https://fonts.gstatic.com/` are fetched; a stylesheet that names another host is refused. Downloads are recorded in `fonts.lock.json` (SRI) and cached under `node_modules/.cache/dusk/fonts`; an offline or failed build uses only copies that match the lock.
- File conventions are read from the top level of `src` only. Every convention becomes an API route with a unique id, and a clash with an existing route is a scan error. Embedded files are capped at 256 KiB.

### Features (`src/features`, `src/server/features.ts`, the pipeline in `src/server/handler.ts`)
- The core pipeline (`handler.ts`) imports no feature implementation: `page`, `rpc`, `isr`, `data-cache`, `api`,
  `sse`, `websocket`, `image-route`, the draft endpoints. A capability (`Capabilities`) is filled only by the feature
  that owns it, in `src/features/<name>.ts`; a path that needs an absent capability is a 404 (never a crash).
- Install order is fixed (`FEATURE_ORDER`). A feature that needs another reads its capability and throws
  `missingFeature` (names the factory and the subpath) when it is absent.
- Creation-time refusals are one table: `checkNeeds` in `handler.ts` (manifest routes, streams, server functions, option
  keys, page-only options). A new option or manifest field that needs a feature is added there, with a `[FEAT-*]` test in
  `test/features.server.test.ts`.
- The generated server entry (`vite/virtual.ts`) passes every feature under the names `duskPages`, `duskRpc`, ...; a user
  `options` export may replace the list. `test/support/features.ts` (`allFeatures()`) is the same list for tests.
- JSDoc examples and messages of the features must not contain `from "` followed by a module: the adapter bundle check
  scans bundle text for it (write `from the "<specifier>" subpath`, as the router does).
- A handler without optional features stays small: its size is the static import closure of the entry, and dynamic chunks are
  counted separately.
- **Option validation lives in the feature that owns the option.** `routing` is validated by `features/routing.ts`,
  `streams` by `features/streams.ts`, `draft` by `features/draft-mode.ts`. `resolveConfig` validates only the core options,
  so a handler without the feature never loads `shared/routing-config.ts` or `shared/path-pattern.ts` (a test pins it).
  An option given without its feature is refused by `checkNeeds` with the factory to add (`[FEAT-15]`).
- **The generated entry passes the option features the app uses** (`vite/virtual.ts`): `routing()` when the baked
  configuration declares a rule, `isr()` when a page or a route revalidates (`revalidates`), `draftMode()` when `draft` is
  set. With an entry file every option feature is passed, because its options are JavaScript the build cannot read.
- **The static-file gate (`runMiddlewareForStaticFiles`).** Off by default: a file is answered before the middleware. On:
  `Handler.gateAsset` exists and the global middleware runs for a request that names a file. The middleware's `next()`
  answers a private marker (`GATE_PASS`); anything else is the answer. The headers of a served file never include the
  framing it owns (`FILE_OWNED`). The Node static layer asks the gate only after it has found a file, and so do the Bun and
  Deno layers (`adapter/native.ts`, the shared fetch); a Cloudflare Worker asks it after the assets binding has the file; a
  platform without a gate (Vercel, Netlify, the static export) warns at build time (`adapter/static-files.ts`).
  Tests: `static-middleware.server.test.ts`, `static-middleware-platform.server.test.ts`, `adapters/native-gate.server.test.ts`.

## Where to look next

- [README.md](README.md): what the package does and every option.
- [SKILL.md](SKILL.md): how to use the released package (install, import paths, a quick start).
- [CONTRIBUTING.md](CONTRIBUTING.md): the short guide to taking part.
- [CHANGELOG.md](CHANGELOG.md): what each release changed.
- [ShadowJS hub](https://github.com/shadowjs-dev/shadow): every repository of the project.
