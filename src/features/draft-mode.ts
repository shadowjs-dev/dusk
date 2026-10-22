import { HttpError } from "../internal/http-error";
import {
  DRAFT_DEFAULTS,
  DRAFT_MAX_AGE_SECONDS,
  type DraftModeSettings,
  draftCookieOn,
  secretsEqual,
  signedDraftValue,
  usableDraftSecret,
} from "../server/draft-mode";
import { redirectResponse } from "../server/errors";
import type { EventState } from "../server/event";
import type { DuskFeature } from "../server/features";
import { formDataOf } from "../server/form";
import { json, readJson } from "../server/json";
import { checkRedirectTarget } from "../server/redirect-target";
import { readProcessEnv, sourceFromPlatform, wantsJson } from "../server/request-env";

/** The secret of draft mode: the platform's variable first, then the process environment. */
function secretFor(platform: unknown, name: string): string | undefined {
  const fromPlatform = sourceFromPlatform(platform)[name];
  return fromPlatform ?? readProcessEnv()?.[name];
}

/** Reads a form or JSON body of a draft endpoint. */
async function draftBody(
  request: Request,
): Promise<{ readonly secret: unknown; readonly path: unknown }> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/json")) {
    const data = await readJson(request);
    return {
      secret: Reflect.get(Object(data), "secret"),
      path: Reflect.get(Object(data), "path"),
    };
  }
  if (
    type.startsWith("application/x-www-form-urlencoded") ||
    type.startsWith("multipart/form-data")
  ) {
    const form = await formDataOf(request);
    return { secret: form.get("secret"), path: form.get("path") };
  }
  throw new HttpError(415, "Expected a form or JSON body");
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Draft mode settings with the defaults filled in; a bad name or path is refused at start. */
function resolveDraft(
  given: Partial<DraftModeSettings> | undefined,
): DraftModeSettings | undefined {
  if (given === undefined) return undefined;
  const settings: DraftModeSettings = { ...DRAFT_DEFAULTS, ...given };
  if (!ENV_NAME.test(settings.secretEnv))
    throw new TypeError("draft.secretEnv must be the name of an environment variable.");
  for (const path of [settings.enablePath, settings.disablePath]) {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new TypeError("draft endpoints must be app paths such as /_dusk/draft/enable.");
  }
  return settings;
}

/**
 * The `draftMode()` feature: preview ("draft") mode. The secret is an environment variable (`draft.secretEnv`),
 * never a URL value; the enable and disable endpoints (`draft.enablePath`, `draft.disablePath`) are POST and
 * CSRF-checked, and set or clear a signed cookie. While draft mode is on, the page cache and `cacheData` read
 * and write nothing.
 *
 * Without it, the endpoint paths are not endpoints, and a `draft` option is refused at creation.
 *
 * @example
 * import { draftMode } from the "@shadow-js/dusk/features/draft-mode" subpath;
 * const handler = createHandler({ manifest, features: [pages(), draftMode()], draft: { secretEnv: "PREVIEW_SECRET" } });
 * @returns The feature.
 * @since 1.0.0
 */
export function draftMode(): DuskFeature {
  return {
    name: "draftMode",
    install(host): void {
      const settings = resolveDraft(host.options.draft);
      /** The answer of a draft endpoint: JSON for a script, a redirect to the path (same site) for a browser. */
      const answerDraft = (event: EventState, path: unknown, enabled: boolean): Response => {
        if (wantsJson(event.request)) return json({ draft: enabled });
        const app =
          typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : "/";
        const location = checkRedirectTarget(
          `${host.config.base}${app}`,
          host.runtime.policyFor(event),
        );
        if (typeof location !== "string") return host.failureResponse(event, location);
        return redirectResponse(location, 303);
      };
      host.capabilities.draftMode = {
        match: (appPath) => {
          if (settings === undefined) return undefined;
          if (appPath === settings.enablePath) return { enable: true };
          if (appPath === settings.disablePath) return { enable: false };
          return undefined;
        },
        enabledFor: async (request, platform) => {
          if (settings === undefined) return false;
          const secret = secretFor(platform, settings.secretEnv);
          return (
            usableDraftSecret(secret) &&
            (await draftCookieOn(request.headers.get("cookie"), settings.cookieName, secret))
          );
        },
        endpoint: async (event, enable) => {
          if (settings === undefined) throw new HttpError(404, "Not Found");
          if (event.method !== "POST")
            throw new HttpError(405, "Method Not Allowed", { headers: { allow: "POST" } });
          const secret = secretFor(event.platform, settings.secretEnv);
          if (!usableDraftSecret(secret)) throw new HttpError(404, "Not Found");
          if (!enable) {
            event.cookies.delete(settings.cookieName);
            return answerDraft(event, "/", false);
          }
          const body = await draftBody(event.request);
          if (typeof body.secret !== "string" || !(await secretsEqual(body.secret, secret))) {
            throw new HttpError(401, "Unauthorized");
          }
          event.cookies.set(
            settings.cookieName,
            await signedDraftValue(settings.cookieName, secret),
            { maxAge: DRAFT_MAX_AGE_SECONDS },
          );
          return answerDraft(event, body.path, true);
        },
      };
    },
  };
}
