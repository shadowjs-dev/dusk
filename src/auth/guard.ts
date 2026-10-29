import { HttpError } from "../internal/http-error";
import { redirect } from "../internal/redirect";
import type { Guard, RequestEvent } from "../server/types";
import type { OidcClient, OidcUser } from "./oidc";

/** Options of {@link requireUser}. @since 1.0.0 */
export interface RequireUserOptions {
  /**
   * Where a visitor who is not signed in is sent (a `GET` or `HEAD` request only; other methods get the 401). The path
   * the visitor wanted is added as `returnTo`. Absent: every request gets a 401.
   */
  readonly loginPath?: string;
  /** An extra check on the signed-in user; `false` answers 403. Use it for roles and allow lists. */
  readonly authorize?: (user: OidcUser, event: RequestEvent) => boolean | Promise<boolean>;
}

/**
 * A guard that lets signed-in visitors through. A visitor who is not signed in gets a 401 (or a redirect to your login
 * route for a page request); a user the `authorize` check refuses gets a 403. It reads the session, so the session
 * middleware must be in the chain. It works wherever a Dusk guard does: `serverFn`, `apiHandler`, `all()`, `any()`.
 *
 * @param client The OIDC client whose session holds the user.
 * @param options Login route and extra check.
 * @returns The guard.
 * @example
 * export const GET = apiHandler({ guard: requireUser(oidc) }, ({ event }) => json({ ok: true }));
 * @since 1.0.0
 */
export function requireUser(
  client: Pick<OidcClient, "user">,
  options: RequireUserOptions = {},
): Guard {
  return async (event) => {
    const user = await client.user(event);
    if (user === undefined) {
      if (options.loginPath !== undefined && (event.method === "GET" || event.method === "HEAD")) {
        const wanted = `${event.url.pathname}${event.url.search}`;
        // A login path that already has a query (`/login?lang=fr`) takes `returnTo` after it.
        const join = options.loginPath.includes("?") ? "&" : "?";
        throw redirect(`${options.loginPath}${join}returnTo=${encodeURIComponent(wanted)}`, {
          status: 303,
        });
      }
      throw new HttpError(401, "Sign in first", { headers: { "cache-control": "no-store" } });
    }
    if (options.authorize !== undefined && !(await options.authorize(user, event))) {
      throw new HttpError(403, "Forbidden");
    }
    return undefined;
  };
}
