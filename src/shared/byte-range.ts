/**
 * Byte ranges of RFC 9110 (14.1.2 `Range`, 13.1.5 `If-Range`), shared by the Node static server, the Bun and Deno layer and
 * `file()`, so the three read the headers the same way. Nothing here touches a file or a runtime.
 *
 * @packageDocumentation
 */

/**
 * Parses a `Range` header against a representation of `size` bytes (RFC 9110 14.1.2 and 14.2).
 *
 * - A header that is not a single `bytes` range is ignored (`null`): another unit, no digits, a range-spec whose last
 *   position is before its first (`bytes=5-2` is invalid, not unsatisfiable), a malformed list. Several valid ranges are
 *   ignored too: this server never builds a multipart answer, and a server may ignore a Range it does not support.
 * - A syntactically valid range that selects nothing is `"unsatisfiable"` (416): it starts at or after the end, or it is
 *   a zero-length suffix.
 *
 * @internal
 * @example parseRange("bytes=5-2", 100); // null: invalid, so the header is ignored
 * @since 1.0.0
 */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  let start: number;
  let end: number;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    // An invalid range-spec makes the whole header ignorable, whatever the size of the file.
    if (last !== "" && Number(last) < start) return null;
    end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Whether an `If-Range` precondition holds (RFC 9110 13.1.5). An entity tag must match by the strong comparison, so a
 * weak tag (`W/"..."`, on either side) never matches. A date must equal the `Last-Modified` of the representation and
 * only counts when that date is a strong validator: the file was last changed at least a second before `nowMs`.
 *
 * @internal
 * @example ifRangeMatches('W/"a"', 'W/"a"', 0, Date.now()); // false: a weak tag never matches
 * @since 1.0.0
 */
export function ifRangeMatches(
  value: string,
  etag: string | undefined,
  mtimeMs: number | undefined,
  nowMs: number,
): boolean {
  const candidate = value.trim();
  if (candidate.startsWith('"') || candidate.startsWith("W/")) {
    return (
      etag !== undefined &&
      !candidate.startsWith("W/") &&
      !etag.startsWith("W/") &&
      candidate === etag
    );
  }
  const date = Date.parse(candidate);
  if (Number.isNaN(date) || mtimeMs === undefined) return false;
  if (nowMs - mtimeMs < 1000) return false;
  return Math.floor(mtimeMs / 1000) * 1000 === date;
}

/**
 * What to do with the `Range` and `If-Range` headers of a request: serve the whole representation (`null`), a slice, or
 * answer 416. Shared by the Node server and the Bun and Deno layer, so both follow one reading of RFC 9110.
 *
 * @internal
 * @example selectRange("bytes=0-3", undefined, undefined, undefined, 100, Date.now()); // { start: 0, end: 3 }
 * @since 1.0.0
 */
export function selectRange(
  rangeHeader: string | undefined,
  ifRange: string | undefined,
  etag: string | undefined,
  mtimeMs: number | undefined,
  size: number,
  nowMs: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (rangeHeader === undefined) return null;
  if (ifRange !== undefined && !ifRangeMatches(ifRange, etag, mtimeMs, nowMs)) return null;
  return parseRange(rangeHeader, size);
}
