import {
  createOidcClient,
  isOidcError,
  type OidcClient,
  type OidcClientOptions,
  requireUser,
} from "../../../src/auth/index";
import {
  apiHandler,
  apiRoute,
  createHandler,
  createSessionManager,
  json,
  type Middleware,
  type RequestEvent,
  type SessionManager,
} from "../../../src/server/index";
import { createTestClient, type TestClient } from "../../../src/testing/index";
import { allFeatures } from "../../support/features";
import { type Idp, type IdpOptions, startIdp } from "./idp";

export const SECRET = "0123456789abcdef0123456789abcdef";
export const REDIRECT_URI = "https://app.test/auth/callback";

export interface AppOptions {
  idp?: IdpOptions;
  /** Overrides for `createOidcClient` (after the defaults). */
  client?: Partial<OidcClientOptions> | ((idp: Idp) => Partial<OidcClientOptions>);
  /** Without discovery: configure the endpoints by hand. */
  endpoints?: boolean;
  dev?: boolean;
  /** Extra options for the session manager. */
  idleTimeoutSeconds?: number;
}

export interface App {
  readonly idp: Idp;
  readonly oidc: OidcClient;
  readonly sessions: SessionManager;
  readonly client: TestClient;
  readonly clock: { t: number };
  /** Makes another browser (its own cookie jar) against the same app. */
  browser(): TestClient;
  /** The whole sign-in as a browser does it; returns the callback response. */
  signIn(returnTo?: string, browser?: TestClient): Promise<Response>;
  /** Starts a sign-in and returns the callback URL the IdP sent the browser to, without opening it. */
  start(returnTo?: string, browser?: TestClient): Promise<URL>;
  close(): Promise<void>;
}

/** An app with the sign-in routes of the guide, a real identity provider and a test client. */
export async function startApp(options: AppOptions = {}): Promise<App> {
  const idp = await startIdp(options.idp);
  const clock = { t: Date.now() };
  const sessions = createSessionManager({
    secrets: [SECRET],
    now: () => clock.t,
    ...(options.idleTimeoutSeconds === undefined
      ? {}
      : { idleTimeoutSeconds: options.idleTimeoutSeconds }),
  });
  const oidc = createOidcClient({
    ...(options.endpoints === true
      ? {
          issuer: idp.issuer,
          endpoints: {
            authorization: `${idp.issuer}/authorize`,
            token: `${idp.issuer}/token`,
            jwks: `${idp.issuer}/jwks`,
            userinfo: `${idp.issuer}/userinfo`,
            endSession: `${idp.issuer}/end_session`,
            revocation: `${idp.issuer}/revoke`,
          },
        }
      : { issuer: idp.issuer }),
    clientId: idp.clientId,
    ...(idp.clientSecret === undefined ? {} : { clientSecret: idp.clientSecret }),
    redirectUri: REDIRECT_URI,
    sessions,
    now: () => clock.t,
    ...(typeof options.client === "function" ? options.client(idp) : options.client),
  });
  const failure = (error: unknown): Response => {
    if (isOidcError(error)) {
      return json(
        { code: error.code, providerError: error.providerError ?? null, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  };
  const route = (handlers: Parameters<typeof apiRoute>[0], path: string) => ({
    id: path,
    path,
    load: async () => apiRoute(handlers),
  });
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [
        route(
          {
            GET: async (event: RequestEvent) => {
              try {
                return await oidc.authorize(event, {
                  ...(event.url.searchParams.has("returnTo")
                    ? { returnTo: event.url.searchParams.get("returnTo") as string }
                    : {}),
                });
              } catch (error) {
                return failure(error);
              }
            },
          },
          "/auth/login",
        ),
        route(
          {
            GET: async (event: RequestEvent) => {
              try {
                return await oidc.handleCallback(event);
              } catch (error) {
                return failure(error);
              }
            },
          },
          "/auth/callback",
        ),
        route(
          {
            GET: apiHandler({ guard: requireUser(oidc) }, async ({ event }) => {
              const user = await oidc.user(event);
              const session = await sessions.get(event);
              return json({ user, sessionId: session.id });
            }),
          },
          "/me",
        ),
        route(
          {
            GET: apiHandler({ guard: requireUser(oidc, { loginPath: "/auth/login" }) }, () =>
              json({ ok: true }),
            ),
          },
          "/page",
        ),
        route(
          {
            GET: apiHandler(
              {
                guard: requireUser(oidc, {
                  authorize: (user) => user.email === "root@example.test",
                }),
              },
              () => json({ ok: true }),
            ),
          },
          "/admin",
        ),
        route(
          {
            POST: async (event: RequestEvent) => {
              try {
                return await oidc.signOut(event, { postLogoutRedirectUri: "/signed-out" });
              } catch (error) {
                return failure(error);
              }
            },
          },
          "/auth/logout",
        ),
        route(
          {
            POST: async (event: RequestEvent) => {
              try {
                const tokens = await oidc.refresh(event);
                return json({
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken ?? null,
                });
              } catch (error) {
                return failure(error);
              }
            },
            GET: async (event: RequestEvent) => {
              try {
                return json({ accessToken: (await oidc.accessToken(event)) ?? null });
              } catch (error) {
                return failure(error);
              }
            },
          },
          "/auth/token",
        ),
        route(
          {
            GET: async (event: RequestEvent) => {
              try {
                return json(await oidc.userinfo(event));
              } catch (error) {
                return failure(error);
              }
            },
          },
          "/auth/userinfo",
        ),
      ],
      serverFns: {},
      assets: { entry: "", css: [], preloads: {}, base: "/" },
      App: () => null,
    },
    dev: options.dev ?? true,
    ...(options.dev === false ? { security: { allowedHosts: ["app.test"] } } : {}),
    middleware: [sessions.middleware() as Middleware],
    onError: () => undefined,
  });
  const make = (): TestClient =>
    createTestClient(handler, { origin: "https://app.test", now: () => clock.t });
  const client = make();
  const start = async (returnTo?: string, browser: TestClient = client): Promise<URL> => {
    const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
    const begin = await browser.get(`/auth/login${query}`);
    const location = begin.headers.get("location");
    if (begin.status !== 302 || location === null) {
      throw new Error(`login answered ${begin.status}: ${await begin.text()}`);
    }
    return idp.approve(location);
  };
  return {
    idp,
    oidc,
    sessions,
    client,
    clock,
    browser: make,
    start,
    async signIn(returnTo, browser = client) {
      const back = await start(returnTo, browser);
      return browser.get(`${back.pathname}${back.search}`);
    },
    close: () => idp.close(),
  };
}
