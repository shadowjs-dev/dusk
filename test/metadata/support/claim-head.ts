/**
 * The head a server writes for `/docs` in the claim app (see claim.server.test.ts, which asserts the handler
 * writes exactly this). The browser test starts from this markup, as a page from the server would, and checks
 * that the client claims these elements instead of adding copies.
 */
export const CLAIM_PATH = "/docs";
export const SERVER_HEAD =
  '<title data-shadow-head>Docs · Malaf</title><meta data-shadow-head name="description" content="How to use it"><link data-shadow-head rel="canonical" href="https://malaf.test/docs">';

/** The layout and the page of the claim app, as the browser and the server both build them. */
export const CLAIM_LAYOUT_METADATA = {
  metadataBase: "https://malaf.test",
  title: { default: "Malaf", template: "%s · Malaf" },
  description: "Storage for agents",
} as const;
export const CLAIM_PAGE_METADATA = {
  title: "Docs",
  description: "How to use it",
  alternates: { canonical: "/docs" },
} as const;
