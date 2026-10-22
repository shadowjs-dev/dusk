import { randomToken } from "../internal/encoding";
import { createKey } from "./context";
import { type CookieOptions, createCookieSigner } from "./cookies";
import type { Middleware, RequestEvent } from "./types";

/** What a store keeps for one session. @since 1.0.0 */
export interface SessionRecord {
  readonly data: Readonly<Record<string, unknown>>;
  /** Milliseconds since epoch when the session was first created. */
  readonly createdAt: number;
  /** When the id was last rotated. */
  readonly rotatedAt: number;
  /** When the session was last seen. */
  readonly lastSeenAt: number;
}

/**
 * Where sessions live. Implement it on Redis or a database to share sessions between processes.
 * `set` receives the time to live in seconds; the store must drop the record after it.
 * @since 1.0.0
 */
export interface SessionStore {
  get(id: string): Promise<SessionRecord | undefined>;
  set(id: string, record: SessionRecord, ttlSeconds: number): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Options of {@link createMemorySessionStore}. @since 1.0.0 */
export interface MemorySessionStoreOptions {
  /** Most sessions kept; the least recently used is dropped beyond it. Default 10 000. */
  readonly maxEntries?: number;
  /** Time source in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * An in-memory session store for development and single-process servers. Bounded: at most
 * `maxEntries` sessions, least recently used evicted first; expired records are dropped on read.
 * Records are copied on the way in and out, so callers cannot change stored state by accident.
 *
 * @param options Bound and clock.
 * @returns The store with a `size` for tests and metrics.
 * @example
 * const store = createMemorySessionStore({ maxEntries: 5_000 });
 * @since 1.0.0
 */
export function createMemorySessionStore(
  options: MemorySessionStoreOptions = {},
): SessionStore & { readonly size: number } {
  const maxEntries = options.maxEntries ?? 10_000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new RangeError("maxEntries must be a positive integer.");
  const now = options.now ?? Date.now;
  const entries = new Map<string, { readonly record: SessionRecord; readonly expiresAt: number }>();
  return {
    get size() {
      return entries.size;
    },
    async get(id) {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(id);
        return undefined;
      }
      entries.delete(id);
      entries.set(id, entry);
      return structuredClone(entry.record);
    },
    async set(id, record, ttlSeconds) {
      entries.delete(id);
      entries.set(id, { record: structuredClone(record), expiresAt: now() + ttlSeconds * 1000 });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
    },
    async delete(id) {
      entries.delete(id);
    },
  };
}

/** Options of {@link createSessionManager}. @since 1.0.0 */
export interface SessionOptions {
  /** Signing secrets (32+ characters); the first signs, all verify, so they can be rotated. */
  readonly secrets: readonly string[];
  /** Server-side store. Default: a bounded in-memory store. */
  readonly store?: SessionStore;
  /**
   * Cookie name. Default: `"__Host-shadow_session"` when the cookie is written with `Secure` (https,
   * production) and the cookie meets the `__Host-` rules (`Path=/`, no `Domain`); otherwise
   * `"shadow_session"` (development over plain http on localhost, a custom `domain` or `path`,
   * `secure: false`). A name you set here is always used as given.
   */
  readonly cookieName?: string;
  /** Cookie attributes. Defaults are `HttpOnly; Secure; SameSite=Lax; Path=/`. */
  readonly cookie?: Pick<CookieOptions, "domain" | "path" | "sameSite" | "secure">;
  /** A session unused for this long ends. Default 1800 (30 minutes). */
  readonly idleTimeoutSeconds?: number;
  /** A session ends this long after it was created, however active. Default 604 800 (7 days). */
  readonly absoluteTimeoutSeconds?: number;
  /** The session id changes after this many seconds. Default 900 (15 minutes). */
  readonly rotateAfterSeconds?: number;
  /**
   * After a timed rotation (`rotateAfterSeconds`) the previous id still works this long, for
   * requests already in flight. Not applied to `regenerate()`, which retires the old id at once.
   * Default 10.
   */
  readonly rotationGraceSeconds?: number;
  /** Time source in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Receives the development warning about an identity key written without `regenerate()` (see
   * {@link signIn}). Default: `console.warn` with the `[dusk]` prefix, like the handler's own
   * warnings. Never called in production.
   */
  readonly onWarning?: (message: string) => void;
}

/**
 * The session of one request.
 * @since 1.0.0
 */
export interface Session {
  /** The current id (changes on `regenerate` and on rotation). */
  readonly id: string;
  /** True when no valid session came with the request. */
  readonly isNew: boolean;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Removes all data, keeping the session. */
  clear(): void;
  /**
   * Gives the session a new id and keeps its data; the old id stops working immediately. Call it
   * when the user signs in.
   */
  regenerate(): void;
  /** Ends the session: the record is deleted and the cookie removed. */
  destroy(): void;
}

/**
 * Loads sessions and saves them after the request.
 * @since 1.0.0
 */
export interface SessionManager {
  /** The session of `event`, loaded on first use. Needs the middleware to be saved. */
  get(event: RequestEvent): Promise<Session>;
  /**
   * Middleware that saves the session and sets its cookie after the rest of the request ran. It
   * saves also when the route failed (`next()` returns the error response), so a login attempt
   * counter or a flash message survives a 4xx or 5xx answer.
   */
  middleware(): Middleware;
}

/** The name when the cookie is `Secure`, `Path=/` and has no `Domain` (the `__Host-` rules). */
const HOST_COOKIE_NAME = "__Host-shadow_session";
/** The name when the cookie cannot be a `__Host-` cookie (plain http on localhost, a `domain`, a `path`). */
const PLAIN_COOKIE_NAME = "shadow_session";

/** Session keys that hold who the visitor is (compared in lower case). Writing one is a sign-in. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "userid",
  "user_id",
  "user",
  "uid",
  "sub",
  "accountid",
  "account_id",
]);

/**
 * Signs a visitor in: gives the session a new id first, then stores `values` in it. The id that came
 * with the request (planted by an attacker before the sign-in, if it was) stops working at once, so
 * session fixation is closed by construction. Data the session held before (an anonymous cart) is
 * kept. Prefer it to calling `session.set("userId", …)` yourself.
 *
 * @param session The session of the request (`await sessions.get(event)`).
 * @param values What identifies the user, for example `{ userId: user.id }`.
 * @example
 * const session = await sessions.get(event);
 * signIn(session, { userId: user.id });
 * @since 1.0.0
 */
export function signIn(session: Session, values: Readonly<Record<string, unknown>>): void {
  session.regenerate();
  for (const [entry, value] of Object.entries(values)) session.set(entry, value);
}

interface Working {
  /** The cookie name this request reads and writes. */
  readonly cookie: string;
  id: string;
  readonly data: Map<string, unknown>;
  readonly isNew: boolean;
  readonly createdAt: number;
  rotatedAt: number;
  lastSeenAt: number;
  /** Id to keep alive briefly after a timed rotation (requests already in flight). */
  previousId: string | undefined;
  /** True after `regenerate()`: the loaded id is deleted at once, so a fixated id is useless. */
  retireLoaded: boolean;
  /** True once the id was regenerated during this request (by `regenerate()` or `signIn()`). */
  regenerated: boolean;
  /** The first identity key this request wrote that the session did not hold before. */
  identityKey: string | undefined;
  dirty: boolean;
  destroyed: boolean;
  readonly loadedId: string | undefined;
}

/**
 * Creates a session manager: signed id cookie, server-side data, idle and absolute lifetimes,
 * periodic id rotation, explicit `regenerate()` against fixation. A cookie whose signature does
 * not verify is treated as no cookie, and the id is never trusted before it verifies.
 *
 * @param options Secrets, store and lifetimes.
 * @returns The manager.
 * @throws Error `COOKIE_SECRET_WEAK` / `COOKIE_SECRET_MISSING` for bad secrets; RangeError for bad lifetimes.
 * @example
 * const sessions = createSessionManager({ secrets: [env.SESSION_SECRET] });
 * createHandler({ manifest, features: [pages()], middleware: [sessions.middleware()] });
 * // in a server function:
 * const session = await sessions.get(event); signIn(session, { userId: user.id });
 * @since 1.0.0
 */
export function createSessionManager(options: SessionOptions): SessionManager {
  const signer = createCookieSigner(options.secrets);
  const store =
    options.store ??
    createMemorySessionStore(options.now === undefined ? {} : { now: options.now });
  const now = options.now ?? Date.now;
  const warn = options.onWarning ?? ((message: string) => console.warn(`[dusk] ${message}`));
  // The default name depends on how the cookie will be written, which the request decides (`Secure` is
  // off for development over plain http on localhost); the same request reads and writes one name.
  const nameOf = (event: RequestEvent): string => {
    if (options.cookieName !== undefined) return options.cookieName;
    const secure = options.cookie?.secure ?? event.cookies.secure;
    const hostRules =
      secure && (options.cookie?.path ?? "/") === "/" && options.cookie?.domain === undefined;
    return hostRules ? HOST_COOKIE_NAME : PLAIN_COOKIE_NAME;
  };
  const idle = options.idleTimeoutSeconds ?? 1800;
  const absolute = options.absoluteTimeoutSeconds ?? 7 * 24 * 3600;
  const rotateAfter = options.rotateAfterSeconds ?? 900;
  const grace = options.rotationGraceSeconds ?? 10;
  for (const [label, value] of [
    ["idleTimeoutSeconds", idle],
    ["absoluteTimeoutSeconds", absolute],
    ["rotateAfterSeconds", rotateAfter],
    ["rotationGraceSeconds", grace],
  ] as const) {
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError(`${label} must be a positive integer.`);
  }
  const key = createKey<Promise<Working>>(`session:${options.cookieName ?? PLAIN_COOKIE_NAME}`);

  const load = async (event: RequestEvent): Promise<Working> => {
    const name = nameOf(event);
    const raw = event.cookies.get(name);
    const id = raw === undefined ? undefined : await signer.unsign(name, raw);
    const time = now();
    if (id !== undefined) {
      const record = await store.get(id);
      if (record !== undefined) {
        const expired =
          time - record.createdAt >= absolute * 1000 || time - record.lastSeenAt >= idle * 1000;
        if (expired) await store.delete(id);
        else {
          const rotate = time - record.rotatedAt >= rotateAfter * 1000;
          return {
            cookie: name,
            id: rotate ? randomToken(24) : id,
            data: new Map(Object.entries(record.data)),
            isNew: false,
            createdAt: record.createdAt,
            rotatedAt: rotate ? time : record.rotatedAt,
            lastSeenAt: time,
            previousId: rotate ? id : undefined,
            retireLoaded: false,
            regenerated: false,
            identityKey: undefined,
            dirty: rotate || time - record.lastSeenAt > (idle * 1000) / 4,
            destroyed: false,
            loadedId: id,
          };
        }
      }
    }
    return {
      cookie: name,
      id: randomToken(24),
      data: new Map(),
      isNew: true,
      createdAt: time,
      rotatedAt: time,
      lastSeenAt: time,
      previousId: undefined,
      retireLoaded: false,
      regenerated: false,
      identityKey: undefined,
      dirty: false,
      destroyed: false,
      loadedId: undefined,
    };
  };

  const handleOf = (working: Working): Session => ({
    get id() {
      return working.id;
    },
    get isNew() {
      return working.isNew;
    },
    get: <T = unknown>(entry: string): T | undefined => working.data.get(entry) as T | undefined,
    set(entry, value) {
      // Writing an identity the session did not hold is a sign-in; updating one it holds is not.
      if (
        working.identityKey === undefined &&
        IDENTITY_KEYS.has(entry.toLowerCase()) &&
        !working.data.has(entry)
      ) {
        working.identityKey = entry;
      }
      working.data.set(entry, value);
      working.dirty = true;
    },
    delete(entry) {
      if (working.data.delete(entry)) working.dirty = true;
    },
    clear() {
      working.data.clear();
      working.dirty = true;
    },
    regenerate() {
      // No grace copy here: whoever held the old id (a fixated one) must not reach the new data.
      working.previousId = undefined;
      working.retireLoaded = working.loadedId !== undefined;
      working.regenerated = true;
      working.id = randomToken(24);
      working.rotatedAt = now();
      working.dirty = true;
    },
    destroy() {
      working.destroyed = true;
    },
  });

  const session = async (event: RequestEvent): Promise<Working> => {
    const existing = event.tryGet(key);
    if (existing !== undefined) return existing;
    const created = load(event);
    event.set(key, created);
    return created;
  };

  const commit = async (event: RequestEvent, working: Working): Promise<void> => {
    const name = working.cookie;
    if (
      __DEV__ &&
      event.dev &&
      working.identityKey !== undefined &&
      !working.regenerated &&
      !working.destroyed
    ) {
      // Checked here, not in set(): `set("userId", …)` followed by `regenerate()` is fine.
      warn(
        `session.set(${JSON.stringify(working.identityKey)}) wrote an identity on a session whose id was not regenerated in this request: an id planted before the sign-in would stay valid (session fixation). Sign in with signIn(session, { ${working.identityKey}: … }) or call session.regenerate() first.`,
      );
    }
    if (working.destroyed) {
      if (working.loadedId !== undefined) await store.delete(working.loadedId);
      if (working.id !== working.loadedId) await store.delete(working.id);
      if (event.cookies.get(name) !== undefined) {
        event.cookies.delete(name, { ...(options.cookie ?? {}) });
      }
      return;
    }
    const idChanged = working.loadedId !== undefined && working.loadedId !== working.id;
    // A brand-new session without data is not worth a cookie or a store entry.
    if (!working.dirty && !(working.isNew && working.data.size > 0) && !idChanged) return;
    const record: SessionRecord = {
      data: Object.fromEntries(working.data),
      createdAt: working.createdAt,
      rotatedAt: working.rotatedAt,
      lastSeenAt: working.lastSeenAt,
    };
    const remaining = Math.max(
      1,
      Math.floor(absolute - (working.lastSeenAt - working.createdAt) / 1000),
    );
    await store.set(working.id, record, Math.min(idle, remaining));
    if (working.previousId !== undefined && working.previousId !== working.id) {
      await store.set(working.previousId, record, grace);
    }
    if (working.retireLoaded && working.loadedId !== undefined && working.loadedId !== working.id) {
      await store.delete(working.loadedId);
    }
    if (idChanged || working.isNew) {
      const signed = await signer.sign(name, working.id);
      event.cookies.set(name, signed, { ...(options.cookie ?? {}), maxAge: remaining });
    }
  };

  return {
    async get(event) {
      return handleOf(await session(event));
    },
    middleware() {
      return async (event, next) => {
        const response = await next();
        const loaded = event.tryGet(key);
        if (loaded !== undefined) await commit(event, await loaded);
        return response;
      };
    },
  };
}
