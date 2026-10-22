import { HttpError } from "../internal/http-error";

/**
 * The decoder of a coded request body (`Content-Encoding: gzip` or `deflate`). It lives in its own module, loaded with
 * `import()` the first time a body is actually coded (see `decodedBody` in `limits.ts`), so an app whose requests are
 * never coded does not pay for it at start-up. The bytes are decoded as they arrive; the caller counts them.
 *
 * @param body The coded body.
 * @param coding The coding of the body.
 * @returns The decoded chunks. A decoder failure is a 400, not a 500.
 * @internal
 */
export function decodeBody(
  body: ReadableStream<BufferSource>,
  coding: "gzip" | "deflate",
): ReadableStream<Uint8Array> {
  const decoded = body.pipeThrough(new DecompressionStream(coding)).getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await decoded.read();
      } catch (cause) {
        controller.error(new HttpError(400, "Invalid compressed request body", { cause }));
        return;
      }
      if (step.done) controller.close();
      else controller.enqueue(step.value);
    },
    cancel(reason) {
      return decoded.cancel(reason);
    },
  });
}
