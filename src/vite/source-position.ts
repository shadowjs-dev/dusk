/**
 * Maps a position in transformed code back to the source it came from, with a source map as
 * `magic-string` writes it (one source, `mappings` in the usual base64 VLQ form). The build uses it
 * to point an error found in the text a transform produced at the line the author wrote.
 */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes the base64 VLQ numbers of one segment. */
function decodeSegment(text: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const char of text) {
    const digit = BASE64.indexOf(char);
    if (digit === -1) throw new TypeError(`source map: "${char}" is not a base64 VLQ digit.`);
    value += (digit & 31) << shift;
    if ((digit & 32) === 0) {
      values.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  return values;
}

/**
 * The original line and column of a generated position.
 *
 * @param map The source map; only `mappings` is read.
 * @param line 1-based line in the generated code.
 * @param column 0-based column in the generated code.
 * @returns The 1-based line and 0-based column in the source, or `undefined` when the generated
 *   position has no mapping (text the transform added).
 * @example
 * originalPosition({ mappings: "AAAA" }, 1, 0); // { line: 1, column: 0 }
 * @since 1.0.0
 */
export function originalPosition(
  map: { readonly mappings: string },
  line: number,
  column: number,
): { line: number; column: number } | undefined {
  let sourceLine = 0;
  let sourceColumn = 0;
  const generatedLines = map.mappings.split(";");
  for (let index = 0; index < generatedLines.length; index += 1) {
    let generatedColumn = 0;
    const segments = generatedLines[index] ?? "";
    let best: { line: number; column: number } | undefined;
    if (segments !== "") {
      for (const segment of segments.split(",")) {
        const fields = decodeSegment(segment);
        generatedColumn += fields[0] ?? 0;
        if (fields.length < 4) continue;
        sourceLine += fields[2] ?? 0;
        sourceColumn += fields[3] ?? 0;
        if (index + 1 === line && generatedColumn <= column) {
          // Text after a segment start is copied one to one, so the offset carries over.
          best = { line: sourceLine + 1, column: sourceColumn + (column - generatedColumn) };
        }
      }
    }
    if (index + 1 === line) return best;
  }
  return undefined;
}

/**
 * The offset of a position, the inverse of `lineColumn`.
 *
 * @param source The text.
 * @param line 1-based line.
 * @param column 0-based column.
 * @returns The 0-based offset, clamped to the text.
 * @example
 * offsetAt("a\nbc", 2, 1); // 3
 * @since 1.0.0
 */
export function offsetAt(source: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return source.length;
    offset = next + 1;
  }
  return Math.min(offset + column, source.length);
}
