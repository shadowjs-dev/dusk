import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { selectRange } from "../shared/byte-range";

/**
 * The `Range` answer of a static file on Bun and Deno. Loaded with `import()` the first time a request carries a `Range`
 * header, so the parser is not part of the bundle of a server that never sees one.
 *
 * @param request The request; its `Range` and `If-Range` decide.
 * @param headers The headers of the whole-file answer; a 206 or 416 adjusts them.
 * @param etag The entity tag of the file.
 * @param info Its size and modification time.
 * @param real The path to read.
 * @returns The 206 or 416 answer, or `undefined` when the whole file is to be sent.
 * @internal
 */
export function rangedResponse(
  request: Request,
  headers: Headers,
  etag: string,
  info: { readonly size: number; readonly mtimeMs: number },
  real: string,
): Response | undefined {
  const range = selectRange(
    request.headers.get("range") ?? undefined,
    request.headers.get("if-range") ?? undefined,
    etag,
    info.mtimeMs,
    info.size,
    Date.now(),
  );
  if (range === null) return undefined;
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${info.size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(
    request.method === "HEAD"
      ? null
      : (Readable.toWeb(createReadStream(real, range)) as unknown as ReadableStream<Uint8Array>),
    { status: 206, headers },
  );
}
