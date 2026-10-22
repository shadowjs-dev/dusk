/**
 * `after(task)`: work that runs after the response has been sent (logging, analytics, cache warming). A task
 * is queued for the request; the handler starts the queue once the response body has ended, or hands it to the
 * platform's `waitUntil` when the platform has one. A failing task is reported through instrumentation and
 * never reaches the response or the process.
 *
 * @packageDocumentation
 */

import { getRequestEvent } from "./context";

/** Most tasks one request may queue. */
export const AFTER_LIMIT = 32;

const queues = new WeakMap<object, (() => unknown)[]>();

/**
 * Queues a task for the event. Internal: the public `after` finds the event.
 *
 * @param event The request event (the key of the queue).
 * @param task The work.
 * @throws TypeError when the task is not a function; RangeError past {@link AFTER_LIMIT} tasks.
 * @internal
 */
export function queueAfter(event: object, task: () => unknown): void {
  if (typeof task !== "function") throw new TypeError("after(task): the task must be a function.");
  const queue = queues.get(event) ?? [];
  if (queue.length >= AFTER_LIMIT) {
    throw new RangeError(`after(): a request queues at most ${AFTER_LIMIT} tasks.`);
  }
  queue.push(task);
  queues.set(event, queue);
}

/**
 * Removes and returns the tasks queued for an event.
 *
 * @param event The request event.
 * @returns The tasks, in the order they were queued.
 * @internal
 */
export function takeAfterTasks(event: object): (() => unknown)[] {
  const queue = queues.get(event) ?? [];
  queues.delete(event);
  return queue;
}

/**
 * Runs tasks one after another. Each failure goes to `report`; nothing is thrown. The first step waits a
 * microtask so a task never runs inside the call that starts the queue.
 *
 * @param tasks The tasks.
 * @param report Receives each failure.
 * @returns A promise that settles when every task has run.
 * @internal
 */
export async function runAfterTasks(
  tasks: readonly (() => unknown)[],
  report: (error: unknown) => void,
): Promise<void> {
  await Promise.resolve();
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      report(error);
    }
  }
}

/**
 * Runs `task` after the response has been sent. Call it while a request is being handled (in a loader, a
 * server function, an API route or a middleware).
 *
 * @param task The work. Its result is ignored; a failure is reported to instrumentation.
 * @returns Nothing.
 * @throws DuskError `SERVER_NO_REQUEST_EVENT` outside a request; TypeError for a non-function; RangeError past 32 tasks.
 * @example
 * export const GET = (event) => { after(() => analytics.track("view", event.url.pathname)); return new Response("ok"); };
 * @since 1.0.0
 */
export function after(task: () => unknown): void {
  queueAfter(getRequestEvent(), task);
}
