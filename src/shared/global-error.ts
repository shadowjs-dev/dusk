import type { Metadata } from "../metadata/types";

/**
 * Props of the global error component (`src/routes/_global-error.tsx`). The error is the public one: the reason
 * phrase in production, the message in development (the same rule as a route's `error` UI).
 *
 * @since 1.0.0
 */
export interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string };
  /**
   * Retries the render. On the server it does nothing (the answer carries no script). In the browser it reloads the
   * document, which is the only recovery for a failure above the routes.
   */
  readonly reset: () => void;
}

/**
 * The global error module: the default export is the component that replaces the whole document; `metadata` is its
 * head (title, robots, ...). The scanner finds the file; the server and `hydrateDusk({ globalError })` take the module.
 *
 * @since 1.0.0
 * @example
 * // src/routes/_global-error.tsx
 * export const metadata = { title: "Something went wrong" };
 * export default function GlobalError({ error, reset }) { return <html><body>...</body></html>; }
 */
export interface GlobalErrorModule {
  readonly default: (props: GlobalErrorProps) => unknown;
  readonly metadata?: Metadata;
}
