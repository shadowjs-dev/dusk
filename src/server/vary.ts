/**
 * Adds the names of a `Vary` value to the `Vary` of a set of headers, each name once (compared without case). `*` means
 * the answer depends on everything, so it replaces the list. Used where two parties add to one answer's `Vary` (a route and
 * the framework's CORS), so neither drops the other's names.
 *
 * @param headers The headers of the answer; their `Vary` is replaced by the merged list.
 * @param extra A `Vary` value to add.
 * @internal
 */
export function mergeVary(headers: Headers, extra: string): void {
  const names = new Map<string, string>();
  for (const part of `${headers.get("vary") ?? ""},${extra}`.split(",")) {
    const name = part.trim();
    if (name !== "" && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  if (names.size > 0) headers.set("vary", names.has("*") ? "*" : [...names.values()].join(", "));
}
