/**
 * A small glob matcher for the import protection lists: `*` matches within a path segment, `**` a
 * run of segments, `?` one character, `{a,b}` alternatives. Paths use `/` and are relative to the
 * project root. No dependency and no regular expressions: matching walks the segments with
 * dynamic programming, so a hostile pattern or path cannot make it slow.
 */

const MAX_ALTERNATIVES = 256;

/** Expands `{a,b}` groups (no nesting) into the list of plain patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) {
    if (pattern.includes("}")) throw new TypeError(`compileGlob: unbalanced "}" in "${pattern}"`);
    return [pattern];
  }
  const close = pattern.indexOf("}", open);
  if (close === -1) throw new TypeError(`compileGlob: unbalanced "{" in "${pattern}"`);
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const choices = pattern.slice(open + 1, close).split(",");
  const out: string[] = [];
  for (const choice of choices) {
    for (const rest of expandBraces(`${head}${choice}${tail}`)) {
      out.push(rest);
      if (out.length > MAX_ALTERNATIVES) {
        throw new TypeError(
          `compileGlob: "${pattern}" expands to more than ${MAX_ALTERNATIVES} patterns`,
        );
      }
    }
  }
  return out;
}

/** `*` and `?` against one path segment. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let resume = 0;
  while (t < text.length) {
    const char = pattern.charAt(p);
    if (p < pattern.length && (char === "?" || char === text.charAt(t)) && char !== "*") {
      p += 1;
      t += 1;
    } else if (p < pattern.length && char === "*") {
      starAt = p;
      resume = t;
      p += 1;
    } else if (starAt !== -1) {
      p = starAt + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (pattern.charAt(p) === "*") p += 1;
  return p === pattern.length;
}

/** Whether `segments` of a pattern match the segments of a path. */
function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const width = path.length + 1;
  // reach[i * width + j]: pattern[i..] matches path[j..]
  const reach = new Uint8Array((pattern.length + 1) * width);
  reach[pattern.length * width + path.length] = 1;
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    const segment = pattern[i] ?? "";
    for (let j = path.length; j >= 0; j -= 1) {
      let ok = false;
      if (segment === "**") {
        const last = i === pattern.length - 1;
        // `**` takes one or more segments, or none unless it is the last (`dir/**` needs a child).
        ok =
          (!last && reach[(i + 1) * width + j] === 1) ||
          (j < path.length &&
            (reach[i * width + j + 1] === 1 || reach[(i + 1) * width + j + 1] === 1));
        if (last && j < path.length) ok = true;
      } else if (j < path.length) {
        ok = reach[(i + 1) * width + j + 1] === 1 && matchSegment(segment, path[j] ?? "");
      }
      if (ok) reach[i * width + j] = 1;
    }
  }
  return reach[0] === 1;
}

/**
 * Compiles a glob to a predicate.
 *
 * @param pattern Glob such as `**\/*.server.ts`; a `**` matches any number of folders.
 * @returns A function that tells whether a relative POSIX path matches.
 * @throws TypeError for an unbalanced brace or a brace group that expands to too many patterns.
 * @example
 * compileGlob("**\/*.server.{ts,tsx}")("src/a/db.server.ts"); // true
 * @since 1.0.0
 */
export function compileGlob(pattern: string): (path: string) => boolean {
  const alternatives = expandBraces(pattern).map((text) => text.split("/"));
  return (path) => {
    const segments = path.split("/");
    return alternatives.some((alternative) => matchSegments(alternative, segments));
  };
}

/**
 * True when any of the predicates matches.
 *
 * @internal
 * @example matchesAny([compileGlob("**\/*.ts")], "src/a.ts"); // true
 * @since 1.0.0
 */
export function matchesAny(
  predicates: readonly ((path: string) => boolean)[],
  path: string,
): boolean {
  for (const predicate of predicates) if (predicate(path)) return true;
  return false;
}
