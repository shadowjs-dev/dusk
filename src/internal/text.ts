/**
 * True when the text holds a C0 control character or DEL. Checked by code point, so no regular expression
 * has to spell out control characters (which the linter, rightly, rejects in a pattern).
 * @internal
 */
export function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The text without the run of `char` at its end. Scanned from the end, so the time is linear in the run:
 * `text.replace(/\/+$/, "")` retries from every start position and takes quadratic time on `////...a/`.
 *
 * @param text The text to trim.
 * @param char The single character to remove from the end.
 * @returns The text without trailing `char`.
 * @example trimEndChar("/a//", "/"); // "/a"
 * @internal
 */
export function trimEndChar(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}
