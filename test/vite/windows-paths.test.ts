import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { isWindowsReservedName, PrerenderError, prerenderFile } from "../../src/vite/build";
import { escapesFolder, isInsideFolder } from "../../src/vite/containment";
import { aliasedPackageFolders } from "../../src/vite/import-protection";

// The rules are checked with `path.win32` inputs, so the Windows branch runs on every machine.
describe("folder containment with Windows paths", () => {
  it("[DSK-W-01] a target inside a root given with forward slashes is inside, whatever the separator", () => {
    // Vite gives `config.root` with forward slashes; `resolve` gives backslashes. Both must agree.
    expect(isInsideFolder("C:/proj", "C:/proj/dist", win32)).toBe(true);
    expect(isInsideFolder("C:/proj", "C:\\proj\\dist", win32)).toBe(true);
    expect(isInsideFolder("C:\\proj", "C:/proj/dist/server/entry.js", win32)).toBe(true);
    expect(isInsideFolder("C:/proj", "C:/proj/..x", win32)).toBe(true);
  });

  it("[DSK-W-02] the root itself, a sibling, a parent and another drive are not inside", () => {
    expect(isInsideFolder("C:/proj", "C:/proj", win32)).toBe(false);
    expect(isInsideFolder("C:/proj", "C:/other", win32)).toBe(false);
    expect(isInsideFolder("C:/proj", "C:/proj/../x", win32)).toBe(false);
    expect(isInsideFolder("C:/proj", "C:/proj-old/dist", win32)).toBe(false);
    expect(isInsideFolder("C:/proj", "D:/proj/dist", win32)).toBe(false);
  });

  it("[DSK-W-03] a path that leaves the folder is detected by segment, not by prefix", () => {
    expect(escapesFolder("..", win32)).toBe(true);
    expect(escapesFolder("..\\x", win32)).toBe(true);
    expect(escapesFolder("D:\\x", win32)).toBe(true);
    expect(escapesFolder("..x", win32)).toBe(false);
    expect(escapesFolder("..x\\y", win32)).toBe(false);
    expect(escapesFolder("src\\..\\a", win32)).toBe(false);
    expect(escapesFolder("../x", posix)).toBe(true);
    expect(escapesFolder("..x/y", posix)).toBe(false);
  });

  it("[DSK-W-04] a package alias to a drive-letter path still names its folder", () => {
    expect(
      aliasedPackageFolders([
        { find: "@shadow-js/dusk/server", replacement: "C:\\repo\\src\\server\\index.ts" },
      ]),
    ).toEqual(["C:/repo/src/server/"]);
    expect(
      aliasedPackageFolders([
        { find: "@shadow-js/dusk/server", replacement: "C:/repo/src/server/index.ts" },
      ]),
    ).toEqual(["C:/repo/src/server/"]);
    expect(
      aliasedPackageFolders([
        {
          find: /^@shadow-js\/dusk\/node$/,
          replacement: "C:\\repo\\src\\node\\index.ts",
        },
      ]),
    ).toEqual(["C:/repo/src/node/"]);
    expect(
      aliasedPackageFolders([{ find: "@shadow-js/dusk/server", replacement: "./src/server" }]),
    ).toEqual([]);
  });
});

describe("Windows device names as prerender folders", () => {
  it("[DSK-W-05] CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are reserved with or without an extension, in any case", () => {
    for (const name of [
      "CON",
      "con",
      "Prn",
      "aux.txt",
      "NUL.html",
      "com1",
      "COM9.json",
      "LPT1",
      "lpt9.x",
      "CON ",
      "nul.",
    ]) {
      expect(isWindowsReservedName(name), name).toBe(true);
    }
    for (const name of [
      "console",
      "contact",
      "auxiliary",
      "nul-x",
      "my-con",
      "con example",
      "com0",
      "lpt10",
      "about",
    ]) {
      expect(isWindowsReservedName(name), name).toBe(false);
    }
  });

  it("[DSK-W-06] a route whose folder is a reserved name is refused, and the error names the route", () => {
    const client = join("/app", "dist", "client");
    expect(() => prerenderFile(client, "/docs/CON")).toThrow(PrerenderError);
    expect(() => prerenderFile(client, "/docs/CON")).toThrow(/\/docs\/CON/);
    expect(() => prerenderFile(client, "/lpt1.html/x")).toThrow(/\/lpt1\.html\/x/);
    expect(prerenderFile(client, "/console")).toBe(join(client, "console", "index.html"));
  });

  it("[DSK-W-07] a folder named ..x is a valid prerender folder; ../x is still refused", () => {
    const client = join("/app", "dist", "client");
    expect(prerenderFile(client, "/..x/page")).toBe(join(client, "..x", "page", "index.html"));
    expect(() => prerenderFile(client, "/a/%2e%2e/b")).toThrow(PrerenderError);
  });
});
