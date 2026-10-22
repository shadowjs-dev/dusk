import { useResource } from "@shadow-js/core";
import { ErrorBoundary, Suspense } from "@shadow-js/web";

/**
 * `<Await>`: shows deferred data. Renders `fallback` until `resolve` settles, then `children(value)`; a
 * rejection renders `errorElement(error)` (or rethrows to the nearest error boundary when there is none).
 * It is `Suspense` and `ErrorBoundary` over a resource of the promise, so it streams like them: on the
 * server a pending promise holds the stream of its boundary, and the browser claims the same markup.
 *
 * @since 1.0.0
 */
export interface AwaitProps<T> {
  /** The data. A promise that is created once per `<Await>`; a new promise restarts the wait. */
  readonly resolve: PromiseLike<T>;
  /** Renders the value. Called untracked, once per settled value. */
  readonly children: (value: T) => unknown;
  /** Shown while the promise is pending. */
  readonly fallback?: unknown;
  /** Shown when the promise rejects; receives the error. Without it the error goes to the nearest boundary. */
  readonly errorElement?: (error: Error) => unknown;
}

/**
 * Renders deferred data with a fallback and an error element. Use it for a loader's deferred value, or any
 * promise a component owns.
 *
 * @param props See {@link AwaitProps}.
 * @returns The rendered boundary.
 * @example
 * <Await resolve={comments} fallback={<p>Loading comments</p>} errorElement={() => <p>No comments</p>}>
 *   {(list) => <ul>{list.map((item) => <li>{item}</li>)}</ul>}
 * </Await>
 * @since 1.0.0
 */
export function Await<T>(props: AwaitProps<T>): unknown {
  // The error boundary sits inside the suspense boundary: a streamed boundary can only send content that
  // was rendered where it is, so a rejection must be caught there to reach the stream as the error element.
  return Suspense({
    get fallback() {
      return props.fallback;
    },
    get children() {
      return ErrorBoundary({
        fallback: (error: unknown) => {
          if (props.errorElement === undefined) throw error;
          return props.errorElement(error instanceof Error ? error : new Error(String(error)));
        },
        get children() {
          return Settled(props);
        },
      });
    },
  });
}

/**
 * The settled outcome of the promise: a value, or the name and message of the error it rejected with (plain
 * data, so the server can send it to the browser; the browser rebuilds an `Error` from it).
 * @internal
 */
type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly name: string; readonly message: string };

/** The error an `errorElement` receives: an `Error` with the name and message of the rejection. @internal */
function errorOf(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Reads the outcome of the promise. The resource never rejects: a rejection is data, so the error element is
 * rendered as ordinary content (and reaches a streamed page, which a rejected read could not). The read
 * suspends while the promise is pending. Without an error element the error is thrown to the boundary.
 * @internal
 */
function Settled<T>(props: AwaitProps<T>): unknown {
  const outcome = useResource(
    () => props.resolve,
    (promise: PromiseLike<T>): Promise<Outcome<T>> =>
      Promise.resolve(promise).then(
        (value): Outcome<T> => ({ ok: true, value }),
        (error: unknown): Outcome<T> => {
          const described = error instanceof Error ? error : new Error(String(error));
          return { ok: false, name: described.name, message: described.message };
        },
      ),
  );
  const settled = outcome();
  if (settled === undefined) return null;
  if (settled.ok) return props.children(settled.value);
  const error = errorOf(settled.name, settled.message);
  if (props.errorElement === undefined) throw error;
  return props.errorElement(error);
}
