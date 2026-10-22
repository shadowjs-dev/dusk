import { runAfterTasks } from "./after";

/**
 * Starts the `after()` tasks of a request (see `after.ts`). Loaded the first time a request queues a task, so a handler
 * whose routes never call `after()` does not carry it.
 *
 * - On a platform with `waitUntil`, the work is handed to it as one promise. A `waitUntil` that throws (Workers do
 *   when it is called after the response was sent) is reported; the answer that was built stays what it is.
 * - Otherwise the tasks start when the response body has ended, or when the client cancels it, or at once for an
 *   answer with no body. They never run while the body is still being produced, so a slow task cannot delay a byte.
 *
 * A failing task goes to `report` (the handler's error sink and `onRequestError`), never to the client and never to the
 * process: the returned work always settles.
 *
 * @param tasks The queued tasks, in order.
 * @param report Receives each failure.
 * @param platform The host object of the request (`waitUntil` is read from it).
 * @param response The finished answer.
 * @returns The response to send: the same one, or one whose body starts the tasks when it ends.
 * @internal
 */
export function scheduleAfter(
  tasks: readonly (() => unknown)[],
  report: (error: unknown) => void,
  platform: unknown,
  response: Response,
): Response {
  let started: Promise<void> | undefined;
  const start = (): void => {
    started ??= runAfterTasks(tasks, report);
    // `runAfterTasks` reports task failures and does not reject; a rejection here would be a bug, so it is reported too.
    started.catch(report);
  };
  const waitUntil: unknown =
    typeof platform === "object" && platform !== null
      ? Reflect.get(platform, "waitUntil")
      : undefined;
  if (typeof waitUntil === "function") {
    started = runAfterTasks(tasks, report);
    try {
      Reflect.apply(waitUntil, platform, [started]);
    } catch (error) {
      report(error);
    }
    return response;
  }
  if (response.body === null) {
    start();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await reader.read();
        if (step.done) {
          controller.close();
          start();
        } else controller.enqueue(step.value);
      } catch (error) {
        controller.error(error);
        start();
      }
    },
    cancel(reason) {
      start();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
