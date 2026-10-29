import {
  createMemoryHistory,
  createRouter,
  type HrefOf,
  Outlet,
  RouterProvider,
} from "@shadow-js/router";
import { useHead } from "@shadow-js/web";
import {
  createComponent,
  createServerHead,
  createServerPortals,
  escape as escapeHtml,
  renderToStream,
  renderToString,
  renderToStringAsync,
  serialize,
} from "@shadow-js/web/server";
import { bindSubmissions, createSubmissionStore } from "../client/submissions";
import { isHttpError } from "../internal/http-error";
import { redirectStatus } from "../internal/redirect";
import type * as MetadataServer from "../metadata/server";
import type { GlobalErrorModule, GlobalErrorProps } from "../shared/global-error";
import { commitResponse, responseStatus } from "../shared/response";
import { buildLinkHeader, buildPayload, buildShell, collectAssets } from "./document";
import { sendEarlyHints } from "./early-hints";
import { describeError, errorPageHtml, type NotFoundPage, redirectResponse } from "./errors";
import { type EventState, visibilityOf } from "./event";
import { takeFlash } from "./flash";
import { checkRedirectTarget } from "./redirect-target";
import { openPageState, publicError } from "./route-wrap";
import type { PageRuntime } from "./runtime";

const encoder = new TextEncoder();

/** The head of a page without metadata exports: no metadata tags, no JSON-LD, no route headers. */
const NO_HEAD: MetadataServer.PageHead = { tags: [], jsonLd: [], applyHeaders: () => undefined };

/**
 * The metadata engine of the app, loaded on first use. Undefined when no route exports metadata (the pages feature
 * then never loads it: see `pages({ metadata })`).
 */
async function metadataOf(rt: PageRuntime): Promise<typeof MetadataServer | undefined> {
  return rt.metadata === undefined ? undefined : rt.metadata();
}

/** Tags every document starts with. Routes replace them by identity (a `viewport` meta, say). */
const DEFAULT_HEAD = [
  { tag: "meta", props: { charset: "utf-8" } },
  { tag: "meta", props: { name: "viewport", content: "width=device-width, initial-scale=1" } },
] as const;

/** Registers the default tags in the render's head collector. Not a component: it must not shift hydration keys. */
function registerDefaults(): null {
  useHead([...DEFAULT_HEAD]);
  return null;
}

/**
 * The extra `<head>` markup of one response: the configured string, or what the per-request
 * function returns. A function that throws or returns a non-string is reported (phase `"head"`)
 * and contributes nothing, so a broken hook never takes the page down.
 */
function extraHeadOf(rt: PageRuntime, event: EventState): string {
  const head = rt.config.document.head;
  if (typeof head === "string") return head;
  try {
    const html: unknown = head(event);
    if (typeof html === "string") return html;
    throw new TypeError("document.head must return a string of HTML.");
  } catch (error) {
    rt.report(error, "head", event);
    return "";
  }
}

/** The headers every HTML answer has. */
function htmlHeaders(link: string | undefined): Headers {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (link !== undefined) headers.set("link", link);
  return headers;
}

/**
 * What the page's error boundaries caught while the page rendered. Only the shell decides the status:
 * once the shell is sent (`shellOpen` is false), a later boundary's error changes that boundary's
 * fallback and nothing else. `first` is the first error caught while the shell was open.
 */
interface CaughtRender {
  first: { readonly error: unknown } | undefined;
  shellOpen: boolean;
}

/**
 * The status of a page once its render is done. A status a loader already set stands; otherwise the
 * first error a boundary caught in the shell sets it: its HTTP status, or 500 for any other error.
 */
function statusAfterRender(status: number, caught: CaughtRender, dev: boolean): number {
  const first = caught.first;
  if (status !== 200 || first === undefined) return status;
  return describeError(first.error, dev).status;
}

/** Response for a status that renders no route: the built-in error document (`page`: the built-in 404's title and robots). */
function errorDocument(
  event: EventState,
  status: number,
  message: string,
  page?: NotFoundPage,
): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  const body = errorPageHtml(status, message, event.id, event.document.lang, page);
  return new Response(event.method === "HEAD" ? null : body, { status, headers });
}

/**
 * The global error document: a render that failed above the routes (the root layout, the providers, the app itself)
 * is answered by the `_global-error` module, with its own `<html>` and `<body>`. Status 500 and the public error (the
 * reason phrase in production). The module's metadata is the head; a `<head>` the component wrote takes it. The
 * server's answer has no script, so `reset` does nothing here (the browser's reloads the document).
 */
async function globalErrorDocument(
  rt: PageRuntime,
  event: EventState,
  module: GlobalErrorModule,
  error: unknown,
): Promise<Response> {
  rt.report(error, "render", event);
  const shown = publicError(error, rt.config.dev);
  const props: GlobalErrorProps = {
    error: shown instanceof Error ? shown : new Error(String(shown)),
    reset: () => undefined,
  };
  const head = createServerHead();
  const engine = module.metadata === undefined ? undefined : await metadataOf(rt);
  head.add(engine === undefined ? [] : await engine.globalErrorTags(rt, event, module));
  const rendered = renderToString(
    () => {
      registerDefaults();
      return createComponent(module.default as (props: unknown) => unknown, props);
    },
    { head },
  );
  const html = globalDocument(rendered, head.html(), event.document.lang);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  return new Response(event.method === "HEAD" ? null : html, { status: 500, headers });
}

const HEAD_OPEN = /<head\b/i;
const HTML_OPEN = /<html\b/i;

/**
 * The index just after the first opening `<tag ...>` in `html`, or -1 when there is none. The first `<tag` decides: when
 * no `>` follows it, none follows a later one either, so the search never retries (a pattern such as
 * `/<head\b[^>]*>/` retries from every `<head` and takes quadratic time on `<head <head <head ...`).
 */
function openingTagEnd(html: string, opening: RegExp): number {
  const open = opening.exec(html);
  if (open === null) return -1;
  const close = html.indexOf(">", open.index + open[0].length);
  return close === -1 ? -1 : close + 1;
}

/**
 * The rendered global error with the head written into its document: into its own `<head>` when the component wrote
 * one, otherwise a new `<head>` after the `<html>` tag (or a whole document when the component wrote none).
 */
function globalDocument(rendered: string, headHtml: string, lang: string): string {
  const headAt = openingTagEnd(rendered, HEAD_OPEN);
  if (headAt !== -1) {
    return `<!doctype html>${rendered.slice(0, headAt)}${headHtml}${rendered.slice(headAt)}`;
  }
  const htmlAt = openingTagEnd(rendered, HTML_OPEN);
  if (htmlAt !== -1) {
    return `<!doctype html>${rendered.slice(0, htmlAt)}<head>${headHtml}</head>${rendered.slice(htmlAt)}`;
  }
  // `lang` is `event.document.lang`, which a locale middleware may have taken from the request: escaped as `buildShell` does.
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">${headHtml}</head><body>${rendered}</body></html>`;
}

/** `data-sh` block with the resource values a streamed render would have sent. */
function dataBlock(renderId: string, data: Record<string, unknown>): string {
  return Object.keys(data).length === 0
    ? ""
    : `<script type="application/json" data-sh="${renderId}">${serialize(data)}</script>`;
}

/** Strips one trailing slash, except for the root. */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * Joins the document prefix, the app markup stream and the suffix into one body stream. The suffix is
 * read when the markup ends, because the portals of late Suspense boundaries are known only then.
 */
function composeBody(
  prefix: string,
  first: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  suffixAtEnd: () => string,
  finish: (error?: unknown, canceled?: boolean) => void,
): ReadableStream<Uint8Array> {
  let stage: "head" | "body" | "done" = "head";
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (stage === "head") {
            stage = "body";
            const head = encoder.encode(prefix);
            const joined = new Uint8Array(head.byteLength + (first?.byteLength ?? 0));
            joined.set(head, 0);
            if (first !== undefined) joined.set(first, head.byteLength);
            controller.enqueue(joined);
            return;
          }
          if (stage !== "body") return;
          const { done, value } = await reader.read();
          // cancel() ran while this read was pending: the stream is closed, nothing more to do.
          if (stage !== "body") return;
          if (done) {
            stage = "done";
            controller.enqueue(encoder.encode(suffixAtEnd()));
            controller.close();
            finish();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          const canceled = stage === "done";
          stage = "done";
          if (canceled) return;
          finish(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        stage = "done";
        finish(undefined, true);
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 1 },
  );
}

/** How a page is rendered, from the `ssr` option of the matched routes. */
type RenderMode = "full" | "data-only" | "shell";

/**
 * The render mode of a request: the most restrictive `ssr` option along the chain of matched
 * routes (`false` before `"data-only"` before the default). A path that matches no route renders
 * fully, because its answer is the not-found page.
 */
function renderModeOf(rt: PageRuntime, event: EventState): RenderMode {
  let mode: RenderMode = "full";
  for (const match of rt.pageMatcher.match(event.url.pathname, visibilityOf(event))) {
    const ssr = rt.specs.get(match.id)?.ssr;
    if (ssr === false) return "shell";
    if (ssr === "data-only") mode = "data-only";
  }
  return mode;
}

/**
 * Renders the document shell without route content: the page a single-page app boots from. Its head holds the
 * static metadata of the matched routes, so crawlers and link previews see the page's title and description.
 *
 * @param rt Shared runtime.
 * @param event The request event.
 * @returns A 200 HTML response.
 * @internal
 */
export async function renderShellPage(rt: PageRuntime, event: EventState): Promise<Response> {
  const engine = await metadataOf(rt);
  const headOut = engine === undefined ? NO_HEAD : await engine.shellHead(rt, event);
  const head = createServerHead();
  renderToString(() => registerDefaults(), { head });
  head.add(headOut.tags);
  const { assets } = rt.config.manifest;
  const found = collectAssets(assets, []);
  const { prefix, suffix } = buildShell({
    lang: event.document.lang,
    dir: event.document.dir,
    rootId: rt.config.document.rootId,
    trailingSlash: rt.config.trailingSlash,
    bodyClass: rt.config.document.bodyClass,
    headHtml: head.html(),
    extraHead: extraHeadOf(rt, event),
    nonce: event.nonce,
    stylesheets: found.stylesheets,
    preloads: found.preloads,
    entry: found.entry,
    payload: undefined,
    jsonLd: headOut.jsonLd,
  });
  const body = prefix + suffix;
  const headers = htmlHeaders(buildLinkHeader(found.entry, found.stylesheets, found.preloads));
  headOut.applyHeaders(headers);
  headers.set("content-length", String(encoder.encode(body).byteLength));
  return new Response(event.method === "HEAD" ? null : body, { status: 200, headers });
}

/**
 * Answers a page request: loads the route's data on the server, then renders the app to HTML.
 * Status, redirects and head are final before the first byte of the body.
 *
 * @param rt Shared runtime.
 * @param event The request event.
 * @returns The page response.
 * @internal
 */
export async function renderPage(rt: PageRuntime, event: EventState): Promise<Response> {
  const { config } = rt;
  const obs = event.obs;
  // Before any loader runs, so the browser fetches the assets while the data loads.
  sendEarlyHints(rt, event);
  const mode = renderModeOf(rt, event);
  // `ssr = false`: nothing of the route runs on the server, the browser loads and renders it all.
  if (mode === "shell") {
    // The shell is a 200 for any path, so a page that lists its params is checked here: its router never runs.
    const gate = await rt.paramsGate?.();
    if (await gate?.refuses(event.url.pathname, visibilityOf(event)))
      return errorDocument(event, 404, "Not Found", config.notFoundPage);
    return renderShellPage(rt, event);
  }
  const state = openPageState(event, obs);
  const caught: CaughtRender = { first: undefined, shellOpen: true };
  // An error an error boundary of the page took. It is reported once (the sink dedupes), and the first one
  // of the shell decides the status (see statusAfterRender). A 4xx is an answer, so it is not reported.
  const onCaughtError = (error: unknown): void => {
    if (caught.first === undefined && caught.shellOpen) caught.first = { error };
    if (describeError(error, config.dev).report) rt.report(error, "render", event);
  };
  const router = createRouter({
    routes: rt.pageRoutes,
    features: rt.routerFeatures,
    history: createMemoryHistory({ initialEntries: [`${event.url.pathname}${event.url.search}`] }),
    base: config.base,
    trailingSlash: config.trailingSlash,
    caseSensitive: config.manifest.caseSensitive === true,
    // A private route answers this render only for a rewrite target (see `visibilityOf`).
    visibility: visibilityOf(event),
    context: { event },
    // One hop is enough: the first redirect is answered to the client, which follows the chain.
    maxRedirects: 1,
    onError: (error) => rt.report(error, "loader", event),
    // What a route's error component is shown for a render error: the same public error as a loader's.
    presentError: (error) => publicError(error, config.dev),
  });
  let disposed = false;
  // Set when the response body stream takes over the router: it disposes it when the stream ends.
  let transferred = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    event.signal.removeEventListener("abort", dispose);
    router.dispose();
  };
  event.signal.addEventListener("abort", dispose, { once: true });
  try {
    const outcome = await (obs === undefined
      ? router.ready()
      : obs.run("dusk.loaders", undefined, () => router.ready()));
    if (event.signal.aborted) return new Response(null, { status: 499 });

    if (state.redirect !== undefined) {
      // The target the app asked for is checked as written: the router would turn "//evil.example"
      // into the local path "/evil.example" and hide the attempt. The router's own form (it adds
      // the base path) is checked again before it reaches `Location`.
      const asked = checkRedirectTarget(state.redirect.to, rt.policyFor(event));
      if (typeof asked !== "string") throw asked;
      // The redirect target is a checked string, not a registered route: the typed `href` only
      // takes registered paths, so the checked target is passed on as one.
      const target = checkRedirectTarget(router.href(asked as HrefOf), rt.policyFor(event));
      if (typeof target !== "string") throw target;
      return redirectResponse(target, redirectStatus(state.redirect));
    }

    let status = 200;
    if (outcome.kind === "success") {
      const requested = event.url.pathname;
      const canonical = outcome.location.pathname;
      if (
        requested !== canonical &&
        withoutTrailingSlash(requested) === withoutTrailingSlash(canonical)
      ) {
        return redirectResponse(`${canonical}${outcome.location.search}`, 308);
      }
      const failure = state.failures[0];
      if (failure !== undefined) status = isHttpError(failure) ? failure.status : 500;
    } else if (outcome.kind === "notFound") {
      status = 404;
      if (router.state.matches().length === 0)
        return errorDocument(event, 404, "Not Found", config.notFoundPage);
    } else if (outcome.kind === "error") {
      const description = describeError(outcome.error, event.dev);
      // beforeLoad errors were reported by the route wrapper; this covers the rest (search validation).
      if (description.report && state.failures.length === 0)
        rt.report(outcome.error, "loader", event);
      const response = errorDocument(event, description.status, description.message);
      for (const [name, value] of description.headers) response.headers.set(name, value);
      return response;
    } else {
      return new Response(null, { status: outcome.kind === "canceled" ? 499 : 500 });
    }

    // The flash is read only for a page that renders: a redirect or an error keeps it for the next page.
    const flash = await takeFlash(event, (error) => rt.report(error, "render", event));
    const submissions = createSubmissionStore();
    bindSubmissions(router, submissions);
    if (flash !== undefined) submissions.seed(flash);
    const flashHtml = flash === undefined ? undefined : serialize(flash);
    const matches = router.state.matches();
    // The metadata of the chain is resolved before the render (see metadata/server.ts). A page whose routes export no
    // metadata never loads that engine: its head is empty.
    const engine = await metadataOf(rt);
    const headOut =
      engine === undefined ? NO_HEAD : await engine.pageHead(rt, event, matches, status);
    const dehydrated = router.dehydrate();
    const payload = buildPayload(dehydrated, config.maxPayloadBytes);
    for (const error of payload.errors) rt.report(error, "render", event);
    const collected = collectAssets(
      config.manifest.assets,
      matches.filter((match) => match.kind === "route").map((match) => match.id),
    );
    // A route rule with `csr: false` ships no client code: no entry script and no script preloads.
    const found = event.noClient ? { ...collected, entry: undefined, preloads: [] } : collected;
    const linkHeader = buildLinkHeader(found.entry, found.stylesheets, found.preloads);
    const headers = htmlHeaders(linkHeader);
    if (config.renderHeader) headers.set("x-dusk-render", config.mode);
    headOut.applyHeaders(headers);
    // HEAD renders the page as GET does, so a render error gives the same status; only the body is dropped.
    const isHead = event.method === "HEAD";

    // The head collector gathers what registerDefaults() and the routes' head() (through the
    // Outlet's useHead) register while the app renders; the document is assembled afterward.
    const head = createServerHead();
    // The portals (open dialogs, sheets) the render produces: emitted at the end of the body, after the root.
    const portals = createServerPortals();
    // The metadata tags go in after the render's own registrations, so they win over `head` exports and defaults.
    const applyPageHead = (): void => {
      head.add(headOut.tags);
    };
    const extraHead = extraHeadOf(rt, event);
    const shellFor = (headHtml: string, portalHtml = ""): { prefix: string; suffix: string } =>
      buildShell({
        lang: event.document.lang,
        dir: event.document.dir,
        rootId: config.document.rootId,
        trailingSlash: config.trailingSlash,
        bodyClass: config.document.bodyClass,
        headHtml,
        extraHead,
        nonce: event.nonce,
        stylesheets: found.stylesheets,
        preloads: found.preloads,
        entry: found.entry,
        payload: payload.text,
        flash: flashHtml,
        portals: portalHtml,
        jsonLd: headOut.jsonLd,
      });

    if (mode === "data-only") {
      // The loaders ran and their data is in the payload; the browser renders the page from it.
      renderToString(() => registerDefaults(), { head });
      applyPageHead();
      const { prefix, suffix } = shellFor(head.html());
      const html = prefix + suffix;
      headers.set("content-length", String(encoder.encode(html).byteLength));
      return new Response(isHead ? null : html, { status: responseStatus(event, status), headers });
    }

    const App = config.manifest.App;
    const tree = (): unknown => {
      registerDefaults();
      return createComponent(App as (props: unknown) => unknown, {
        get children() {
          return createComponent(RouterProvider, {
            router,
            get children() {
              return createComponent(Outlet, {});
            },
          });
        },
      });
    };

    if (config.mode === "stream") {
      let headHtml = "";
      const stopShell = obs?.start("dusk.render");
      const stream = renderToStream(tree, {
        renderId: config.renderId,
        ...(event.nonce === undefined ? {} : { nonce: event.nonce }),
        signal: event.signal,
        timeoutMs: config.limits.streamTimeoutMs,
        head,
        portals,
        onCaughtError,
        onShellReady: () => {
          // From here on the status is fixed: errors of later boundaries are reported, not answered.
          caught.shellOpen = false;
          commitResponse(event);
          applyPageHead();
          headHtml = head.html();
        },
      });
      const reader = stream.getReader();
      // The shell is the first chunk: reading it first means a render error is still a 500, not a
      // truncated 200.
      let first: ReadableStreamReadResult<Uint8Array>;
      try {
        first = await reader.read();
      } catch (error) {
        // The stream is already errored and has released its resources; there is nothing to cancel.
        reader.releaseLock();
        stopShell?.(error);
        // A failure before the shell is the app's own (the root layout, the providers): the global error answers it.
        if (config.globalError !== undefined) {
          return globalErrorDocument(rt, event, config.globalError, error);
        }
        throw error;
      }
      stopShell?.();
      if (event.signal.aborted) {
        await reader.cancel(event.signal.reason);
        return new Response(null, { status: 499 });
      }
      // The shell has arrived, so the status is decided: a boundary error in it is a 500 (or its HttpError status).
      status = responseStatus(event, statusAfterRender(status, caught, config.dev));
      if (isHead) {
        await reader.cancel();
        return new Response(null, { status, headers });
      }
      const { prefix } = shellFor(headHtml);
      // The stream outlives the response head: the observation completes when it ends (full render time).
      const stopStream = obs?.tail("dusk.page.stream");
      const body = composeBody(
        prefix,
        first.done ? undefined : first.value,
        reader,
        // Read when the markup has ended: the portals of late Suspense boundaries are known only then.
        () => shellFor(headHtml, portals.html()).suffix,
        (error, canceled) => {
          if (error !== undefined && !event.signal.aborted) rt.report(error, "stream", event);
          stopStream?.(error, canceled);
          dispose();
        },
      );
      transferred = true;
      return new Response(body, { status, headers });
    }

    let rendered: { readonly html: string; readonly data: Record<string, unknown> };
    const stopRender = obs?.start("dusk.render");
    try {
      rendered =
        config.mode === "async"
          ? await renderToStringAsync(tree, {
              renderId: config.renderId,
              timeoutMs: config.limits.streamTimeoutMs,
              head,
              portals,
              onCaughtError,
            })
          : {
              html: renderToString(tree, {
                renderId: config.renderId,
                head,
                portals,
                onCaughtError,
              }),
              data: {},
            };
    } catch (error) {
      stopRender?.(error);
      if (config.globalError === undefined) throw error;
      return globalErrorDocument(rt, event, config.globalError, error);
    }
    stopRender?.();
    // Without a stream the whole render is the shell: its first caught error decides the status.
    status = responseStatus(event, statusAfterRender(status, caught, config.dev));
    commitResponse(event);
    applyPageHead();
    const { prefix, suffix } = shellFor(head.html(), portals.html());
    const html = prefix + rendered.html + dataBlock(config.renderId, rendered.data) + suffix;
    headers.set("content-length", String(encoder.encode(html).byteLength));
    return new Response(isHead ? null : html, { status, headers });
  } finally {
    if (!transferred) dispose();
  }
}
