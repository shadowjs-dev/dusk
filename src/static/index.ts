/**
 * `@shadow-js/dusk/static`: render pages to static files with the production handler (SSG), and
 * the single-page-app shell for hosts that need a fallback document.
 * @packageDocumentation
 */

export { type StaticSiteAdapterOptions, staticSite } from "./adapter";
export {
  type CrawlPolicy,
  DEFAULT_CRAWL,
  internalLinks,
  type PrerenderFailure,
} from "./crawl";
export {
  outputFileFor,
  PrerenderError,
  type PrerenderedPage,
  type PrerenderOptions,
  type PrerenderResult,
  prerender,
} from "./prerender";
