import { type Accessor, untrack, useId, useSignal } from "@shadow-js/core";
import { parseHydrationData, type Router, useOptionalRouter } from "@shadow-js/router";
import { type FlashPayload, isFailure } from "../shared/action";
import type { ServerFnCallOptions } from "../shared/call-options";
import { ROUTER_PAYLOAD_ID } from "../shared/wire";
import { type ClientServerFn, stubInternals } from "./fn";

/**
 * The mutation model of the browser, one store per page: submissions of server functions (their
 * state, input, result, error, retry and clear), fetchers (keyed, non-navigating), the revalidator
 * (manual loader refresh) and the one-time flash the server carried to the page. `<Form>` and the
 * hooks below all write to it, so every component reads the same state.
 */

/** Submissions a store keeps per page: the newest ones; older ones are dropped. @internal */
const MAX_SUBMISSIONS = 50;

/** Fetchers a store keeps: the newest ones; older ones are dropped. @internal */
const MAX_FETCHERS = 100;

/**
 * The state of a submission. `idle` is the state of a key with no submission (or a cleared one).
 * @since 1.0.0
 */
export type SubmissionStatus = "idle" | "pending" | "success" | "error";

/**
 * Options of one submission.
 * @since 1.0.0
 */
export interface SubmitOptions {
  /** Refresh the page's loader data after a success. Default `true`. */
  readonly revalidate?: boolean;
  /** The call already refreshed the page (single flight): no second refresh. Default `false`. */
  readonly singleFlight?: boolean;
}

/**
 * One submission, with its state as accessors. The store keeps it until it is cleared or dropped.
 * @since 1.0.0
 */
export interface Submission<Input = unknown, Output = unknown> {
  /** Stable within a page: `s1`, `s2`, ... in the order the submissions started. */
  readonly id: string;
  /** The key of the submission: a server function id, or any string. */
  readonly key: string;
  /** What was submitted: the arguments, or the `FormData` of a form. */
  readonly input: Input;
  /** `pending`, `success` or `error` (`idle` once cleared). */
  readonly status: Accessor<SubmissionStatus>;
  /** True while the call runs. */
  readonly pending: Accessor<boolean>;
  /** The value of the call; a `fail()` result is here too (see `failed`). */
  readonly result: Accessor<Output | undefined>;
  /** True when the result is a `fail()` failure. */
  readonly failed: Accessor<boolean>;
  /** The thrown error of an `error` submission, or the error of a revalidation that failed after a success. */
  readonly error: Accessor<unknown>;
  /** Settles when the call (and its revalidation) has finished, whatever the outcome. */
  readonly done: Promise<void>;
  /** Removes the submission from the store and resets its state to `idle`. */
  clear(): void;
  /** Runs the call again with the same input. */
  retry(): Promise<void>;
}

/**
 * The read view of a submission that the hooks return: plain values, read reactively when a component
 * reads them.
 * @since 1.0.0
 */
export interface SubmissionView<Input = unknown, Output = unknown> {
  readonly id: string | undefined;
  readonly status: SubmissionStatus;
  readonly pending: boolean;
  readonly input: Input | undefined;
  readonly result: Output | undefined;
  readonly failed: boolean;
  readonly error: unknown;
  clear(): void;
  retry(): Promise<void>;
}

/**
 * The state of a fetcher: `idle`, `loading` (a `load`) or `submitting` (a `submit`).
 * @since 1.0.0
 */
export type FetcherState = "idle" | "loading" | "submitting";

/**
 * A non-navigating loader or mutation with its own state. Keyed: the same key from two components is
 * the same fetcher.
 * @since 1.0.0
 */
export interface Fetcher {
  /** The key the fetcher was made with. */
  readonly key: string;
  /** The state of the last `load` or `submit`. */
  readonly state: Accessor<FetcherState>;
  /** The loader data of the last `load` (the page's matches), or the value of the last `submit`. */
  readonly data: Accessor<unknown>;
  /** The error of the last `load` or `submit`. */
  readonly error: Accessor<unknown>;
  /** The form data of the last `submit`, while it runs. */
  readonly formData: Accessor<FormData | undefined>;
  /** Fetches the page at `url` and keeps its loader data in `data`, without navigating. */
  load(url: string): Promise<void>;
  /** Submits to a server function stub without navigating; resolves when it has finished. */
  submit(target: StubTarget, input: FormData | unknown): Promise<void>;
}

/**
 * The state of the manual revalidation of the page's loader data.
 * @since 1.0.0
 */
export interface Revalidator {
  /** `loading` while a revalidation runs. */
  state(): "idle" | "loading";
  /** Refreshes the loader data of the current location. */
  revalidate(): Promise<void>;
}

/** Anything a submission can target: a server function stub (or its id). @internal */
export type StubTarget = string | { readonly id: string };

/**
 * Options of {@link createSubmissionStore}.
 * @since 1.0.0
 */
export interface SubmissionStoreOptions {
  /** Refreshes the page's loader data (the router's `invalidate`). Called after successful submissions. */
  readonly onRevalidate?: () => unknown;
  /** Navigates (the router's `navigate`): a GET form uses it. */
  readonly navigate?: (to: string, options: { readonly replace: boolean }) => unknown;
}

/**
 * The state of one page: submissions, fetchers, the revalidator and the flash.
 * @since 1.0.0
 */
export interface SubmissionStore {
  /** Starts a submission of `run(input)` under `key`; the result is recorded in the store. */
  submit<Input, Output>(
    key: string,
    run: (input: Input) => Output | PromiseLike<Output>,
    input: Input,
    options?: SubmitOptions,
  ): Submission<Input, Output>;
  /** Starts a submission of a server function stub with the input (form data for a `form: true` function). */
  submitTo(
    target: StubTarget,
    input: unknown,
    options?: ServerFnCallOptions & SubmitOptions,
  ): Submission;
  /** The newest submission of `key` (or of any key), or `undefined`. */
  latest(key?: string): Submission | undefined;
  /** The submissions of `key` (or of all keys), oldest first. */
  list(key?: string): readonly Submission[];
  /** The fetcher of `key`, created on first use. */
  fetcher(key: string): Fetcher;
  /** The revalidator of the page. */
  revalidator(): Revalidator;
  /** Refreshes the page's loader data, with the `loading` state while it runs. */
  revalidate(): Promise<void>;
  /** Navigates (the `navigate` option). Present only when the store has a `navigate` option. */
  readonly navigateTo?: (to: string, replace: boolean) => unknown;
  /** Records what the server carried to this page: the last submission outcome and the one-time flash. */
  seed(payload: FlashPayload): void;
  /** The value set with `setFlash` on the server, once the page has read it. */
  flash(): unknown;
}

/** True for a thenable. @internal */
function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

/** The key of a target. @internal */
function keyOf(target: StubTarget | undefined): string | undefined {
  if (target === undefined) return undefined;
  return typeof target === "string" ? target : target.id;
}

/** `FormData` as the object a server function without `form: true` takes: repeated names are arrays. @internal */
function formDataToObject(data: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of data.entries()) {
    const previous = out[name];
    if (previous === undefined) out[name] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else out[name] = [previous, value];
  }
  return out;
}

/**
 * Calls a target with the input: a form post for a `form: true` function given form data, the call with
 * the input otherwise. @internal
 */
function perform(
  target: StubTarget,
  input: unknown,
  options: ServerFnCallOptions,
): Promise<unknown> {
  const internals = typeof target === "string" ? undefined : stubInternals(target);
  if (internals === undefined || typeof target === "string") {
    return Promise.reject(
      new TypeError("a submission needs a server function (a stub of the Dusk build)"),
    );
  }
  if (input instanceof FormData) {
    if (internals.form) return internals.postForm(input, options);
    return (target as ClientServerFn<unknown, unknown>)(formDataToObject(input), options);
  }
  return (target as ClientServerFn<unknown, unknown>)(input, options);
}

/** Loads the page at `url` and returns the loader data of its matches. @internal */
async function loadPage(url: string): Promise<unknown> {
  const response = await globalThis.fetch(url, {
    headers: { accept: "text/html" },
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`fetcher.load(): the page answered ${response.status}`);
  const html = new DOMParser().parseFromString(await response.text(), "text/html");
  const payload = html.querySelector(`script#${ROUTER_PAYLOAD_ID}`);
  if (payload === null || payload.textContent === null) return undefined;
  return parseHydrationData(payload.textContent).matches;
}

/**
 * Creates the store of a page. The app creates one (`hydrateDusk`, and the server for each render);
 * a test can create its own.
 *
 * @param options The revalidation and navigation the store uses.
 * @returns The store.
 * @example
 * const store = createSubmissionStore({ onRevalidate: () => router.invalidate() });
 * const sub = store.submit("save", async (title: string) => title.trim(), " a ");
 * await sub.done;
 * sub.result(); // "a"
 * @since 1.0.0
 */
export function createSubmissionStore(options: SubmissionStoreOptions = {}): SubmissionStore {
  let counter = 0;
  const [entries, setEntries] = useSignal<readonly Submission[]>([]);
  const [flashValue, setFlashValue] = useSignal<unknown>(undefined);
  const [revalidating, setRevalidating] = useSignal(false);
  const fetchers = new Map<string, Fetcher>();

  const record = (sub: Submission): void => {
    const next = [...untrack(entries), sub];
    const kept = next.length > MAX_SUBMISSIONS ? next.slice(next.length - MAX_SUBMISSIONS) : next;
    setEntries(() => kept);
  };

  const revalidate = async (): Promise<void> => {
    setRevalidating(() => true);
    try {
      await options.onRevalidate?.();
    } finally {
      setRevalidating(() => false);
    }
  };

  const submit = <Input, Output>(
    key: string,
    run: (input: Input) => Output | PromiseLike<Output>,
    input: Input,
    submitOptions: SubmitOptions = {},
  ): Submission<Input, Output> => {
    counter += 1;
    const id = `s${counter}`;
    const [status, setStatus] = useSignal<SubmissionStatus>("pending");
    const [result, setResult] = useSignal<Output | undefined>(undefined);
    const [failed, setFailed] = useSignal(false);
    const [error, setError] = useSignal<unknown>(undefined);
    // Each attempt has a number: an attempt that is no longer the latest (retried, cleared) does not write.
    let attempt = 0;
    const shouldRevalidate =
      submitOptions.revalidate !== false && submitOptions.singleFlight !== true;

    const succeed = async (mine: number, value: Output): Promise<void> => {
      if (mine !== attempt) return;
      setResult(() => value);
      setFailed(() => isFailure(value));
      setStatus(() => "success" as const);
      if (!shouldRevalidate) return;
      try {
        await revalidate();
      } catch (thrown) {
        if (mine === attempt) setError(() => thrown);
      }
    };
    const failWith = (mine: number, thrown: unknown): Promise<void> => {
      if (mine === attempt) {
        setError(() => thrown);
        setStatus(() => "error" as const);
      }
      return Promise.resolve();
    };
    const execute = (): Promise<void> => {
      attempt += 1;
      const mine = attempt;
      setStatus(() => "pending" as const);
      setError(() => undefined);
      let outcome: Output | PromiseLike<Output>;
      try {
        outcome = run(input);
      } catch (thrown) {
        return failWith(mine, thrown);
      }
      // A synchronous outcome settles at once, so a seeded result is never shown as pending.
      if (!isPromiseLike<Output>(outcome)) return succeed(mine, outcome);
      return Promise.resolve(outcome).then(
        (value) => succeed(mine, value),
        (thrown: unknown) => failWith(mine, thrown),
      );
    };

    let current = execute();
    const sub: Submission<Input, Output> = {
      id,
      key,
      input,
      status,
      pending: () => status() === "pending",
      result,
      failed,
      error,
      get done(): Promise<void> {
        return current;
      },
      clear(): void {
        attempt += 1;
        setStatus(() => "idle" as const);
        setResult(() => undefined);
        setFailed(() => false);
        setError(() => undefined);
        setEntries(() => untrack(entries).filter((entry) => entry !== sub));
      },
      retry(): Promise<void> {
        current = execute();
        return current;
      },
    };
    record(sub as Submission);
    return sub;
  };

  const fetcher = (key: string): Fetcher => {
    const known = fetchers.get(key);
    if (known !== undefined) return known;
    if (fetchers.size >= MAX_FETCHERS) {
      const oldest = fetchers.keys().next();
      if (oldest.value !== undefined) fetchers.delete(oldest.value);
    }
    const [state, setState] = useSignal<FetcherState>("idle");
    const [data, setData] = useSignal<unknown>(undefined);
    const [error, setError] = useSignal<unknown>(undefined);
    const [form, setForm] = useSignal<FormData | undefined>(undefined);
    let attempt = 0;
    const made: Fetcher = {
      key,
      state,
      data,
      error,
      formData: form,
      async load(url: string): Promise<void> {
        attempt += 1;
        const mine = attempt;
        setState(() => "loading" as const);
        setError(() => undefined);
        try {
          const loaded = await loadPage(url);
          if (mine === attempt) setData(() => loaded);
        } catch (thrown) {
          if (mine === attempt) setError(() => thrown);
        } finally {
          if (mine === attempt) setState(() => "idle" as const);
        }
      },
      async submit(target: StubTarget, input: FormData | unknown): Promise<void> {
        attempt += 1;
        const mine = attempt;
        setForm(() => (input instanceof FormData ? input : undefined));
        setState(() => "submitting" as const);
        setError(() => undefined);
        try {
          const value = await perform(target, input, {});
          if (mine === attempt) setData(() => value);
        } catch (thrown) {
          if (mine === attempt) setError(() => thrown);
        } finally {
          if (mine === attempt) {
            setForm(() => undefined);
            setState(() => "idle" as const);
          }
        }
      },
    };
    fetchers.set(key, made);
    return made;
  };

  const navigate = options.navigate;
  const store: SubmissionStore = {
    ...(navigate === undefined
      ? {}
      : { navigateTo: (to: string, replace: boolean): unknown => navigate(to, { replace }) }),
    submit,
    submitTo(target, input, callOptions = {}) {
      const internals = typeof target === "string" ? undefined : stubInternals(target);
      const { revalidate: revalidateOption, singleFlight, ...rest } = callOptions;
      const sub = submit(
        keyOf(target) ?? "",
        (value: unknown) => perform(target, value, rest),
        input,
        {
          ...(revalidateOption === undefined ? {} : { revalidate: revalidateOption }),
          singleFlight: singleFlight ?? internals?.singleFlight === true,
        },
      );
      return sub as Submission;
    },
    latest(key) {
      const all = entries();
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const entry = all[index];
        if (entry !== undefined && (key === undefined || entry.key === key)) return entry;
      }
      return undefined;
    },
    list(key) {
      return entries().filter((entry) => key === undefined || entry.key === key);
    },
    fetcher,
    revalidator(): Revalidator {
      return {
        state: () => (revalidating() ? "loading" : "idle"),
        revalidate: () => revalidate(),
      };
    },
    revalidate,
    seed(payload) {
      const wire = payload.submission;
      if (wire !== undefined) {
        const outcome = wire.status === "success" ? wire.value : wire.error;
        const throws = wire.status === "error";
        submit(
          wire.key,
          () => {
            if (throws) throw outcome;
            return outcome;
          },
          undefined,
          { revalidate: false },
        );
      }
      if (payload.flash !== undefined) setFlashValue(() => payload.flash);
    },
    flash: () => flashValue(),
  };
  return store;
}

/**
 * The view of the submissions a hook reads: the submission `read()` returns, with plain values read when
 * a component reads them.
 * @internal
 */
function viewOf(read: () => Submission | undefined): SubmissionView {
  return {
    get id() {
      return read()?.id;
    },
    get status() {
      return read()?.status() ?? "idle";
    },
    get pending() {
      return read()?.pending() ?? false;
    },
    get input() {
      return read()?.input;
    },
    get result() {
      return read()?.result();
    },
    get failed() {
      return read()?.failed() ?? false;
    },
    get error() {
      return read()?.error();
    },
    clear() {
      read()?.clear();
    },
    retry() {
      return read()?.retry() ?? Promise.resolve();
    },
  };
}

/** The store of each router (a page): bound by {@link bindSubmissions}. A WeakMap, so it goes with the router. */
const storeByRouter = new WeakMap<Router, SubmissionStore>();

/**
 * Binds the store of a page to its router: `hydrateDusk` does it in the browser, the server render does it
 * for each request. The components of the page find the store through their router, so the component tree
 * is the same as without a store.
 *
 * @param router The page's router.
 * @param store The store of the page.
 * @internal
 */
export function bindSubmissions(router: Router, store: SubmissionStore): void {
  storeByRouter.set(router, store);
}

/**
 * The store of the page the component renders in. Without a bound store (a page not mounted by
 * `hydrateDusk`, or a test) each call has its own store.
 * @internal
 */
export function currentStore(): SubmissionStore {
  const router = useOptionalRouter();
  const found = router === undefined ? undefined : storeByRouter.get(router);
  return found ?? createSubmissionStore();
}

/**
 * The state of the latest submission of a server function (or of any submission when called without one).
 * It is reactive: a component that reads `status` or `result` updates when the submission changes. A
 * submission starts with `useSubmit()`, a `<Form>` or a fetcher.
 *
 * @param target The server function (its stub), or a key. Omit it for the newest submission of any key.
 * @returns A view: `status` (`idle`, `pending`, `success`, `error`), `pending`, `input`, `result`,
 *   `failed`, `error`, `id`, `clear()` and `retry()`.
 * @example
 * const last = useSubmission(saveNote);
 * <p>{last.pending ? "Saving" : last.status}</p>
 * @since 1.0.0
 */
export function useSubmission<Input = unknown, Output = unknown>(
  target?: StubTarget,
): SubmissionView<Input, Output> {
  const store = currentStore();
  const key = keyOf(target);
  return viewOf(() => store.latest(key)) as SubmissionView<Input, Output>;
}

/**
 * Every submission of a server function (or of all keys), oldest first, read as a function that returns the
 * list. The list is bounded (the newest 50 submissions of the page).
 *
 * @param target The server function (its stub), or a key. Omit it for all submissions.
 * @returns A function that returns the views.
 * @example
 * const history = useSubmissions(saveNote);
 * <ul>{history().map((sub) => <li>{sub.status}</li>)}</ul>
 * @since 1.0.0
 */
export function useSubmissions(target?: StubTarget): () => readonly SubmissionView[] {
  const store = currentStore();
  const key = keyOf(target);
  return () => store.list(key).map((sub) => viewOf(() => sub));
}

/**
 * A function that starts a submission of a server function on the page's store (its state then shows in
 * `useSubmission`). Use it for a mutation that is not a form: a button, a drag, an effect.
 *
 * @returns `submit(target, input, options)`: returns the submission. `options.revalidate: false` skips the
 *   refresh of the loader data, and `singleFlight` functions are refreshed by their own answer.
 * @example
 * const submitNote = useSubmit();
 * <button onClick={() => submitNote(saveNote, { title: "Draft" })}>Save</button>
 * @since 1.0.0
 */
export function useSubmit(): (
  target: StubTarget,
  input: unknown,
  options?: ServerFnCallOptions & SubmitOptions,
) => Submission {
  const store = currentStore();
  return (target, input, options) => store.submitTo(target, input, options);
}

/**
 * A fetcher: a mutation or a load that does not navigate and has its own state. Keyed: the same key in two
 * components is the same fetcher, so one can show the state another one started. Without a key the
 * fetcher is private to the component.
 *
 * @param key The key of the fetcher.
 * @returns The fetcher (`load`, `submit`, `state`, `data`, `error`, `formData`).
 * @example
 * const inbox = useFetcher("inbox");
 * <button onClick={() => inbox.load("/inbox")}>Refresh</button>
 * @since 1.0.0
 */
export function useFetcher(key?: string): Fetcher {
  const store = currentStore();
  const generated = useId();
  return store.fetcher(key ?? generated);
}

/**
 * The page's revalidator: `state` (`idle` or `loading`) and `revalidate()`, which refreshes the loader data
 * of the current location.
 *
 * @returns The revalidator.
 * @example
 * const revalidator = useRevalidator();
 * <button onClick={() => revalidator.revalidate()}>{revalidator.state() === "loading" ? "Refreshing" : "Refresh"}</button>
 * @since 1.0.0
 */
export function useRevalidator(): Revalidator {
  return currentStore().revalidator();
}

/**
 * The one-time value the server set with `setFlash` for this page (read once; the server clears the cookie).
 *
 * @returns An accessor of the value, `undefined` when there is none.
 * @example
 * const notice = useFlash<string>();
 * <p>{notice()}</p>
 * @since 1.0.0
 */
export function useFlash<T = unknown>(): () => T | undefined {
  const store = currentStore();
  return () => store.flash() as T | undefined;
}
