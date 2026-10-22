/**
 * Errors a server function call can fail with on the client, besides `HttpError` (the server's
 * 4xx answers, rebuilt as the same class the server throws) and the router's `redirect()` and
 * `notFound()` control-flow signals.
 */

/**
 * The server failed to run the function and told the client no more than the status: an unexpected
 * error on the server (anything that is not an `HttpError`), a method the function does not accept,
 * or an aborted request. The message is the public text (the reason phrase in production); details
 * and the stack stay in the server's log (look for `requestId` there). An `HttpError` the function
 * threw is not a `ServerFnError`: it arrives as an `HttpError` with the same status.
 *
 * @example
 * try { await saveTodo(todo); } catch (error) {
 *   if (error instanceof ServerFnError) console.warn(error.status, error.requestId);
 * }
 * @since 1.0.0
 */
export class ServerFnError extends Error {
  /** The HTTP status of the answer. */
  readonly status: number;
  /** Id of the request on the server, for the server log. */
  readonly requestId: string | undefined;

  /**
   * @param message Public text from the server.
   * @param status HTTP status.
   * @param requestId Request id from the server, if it sent one.
   */
  constructor(message: string, status: number, requestId: string | undefined) {
    super(message);
    this.name = "ServerFnError";
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * The answer was not a server function answer: an HTML error page from a proxy, a truncated body,
 * a redirect the browser did not follow, an envelope of another version. The call may or may not
 * have run on the server.
 *
 * @since 1.0.0
 */
export class ServerFnProtocolError extends Error {
  /** The HTTP status of the answer, `0` when there was none. */
  readonly status: number;

  /**
   * @param message What was wrong with the answer.
   * @param status HTTP status, `0` when unknown.
   * @param cause The parse or decode error behind it, if any.
   */
  constructor(message: string, status: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ServerFnProtocolError";
    this.status = status;
  }
}
