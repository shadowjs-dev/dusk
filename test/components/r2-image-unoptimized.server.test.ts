import { createComponent, renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { loadComponent } from "./support/compile";

type Module = { Image: (props: Record<string, unknown>) => unknown };

async function render(props: Record<string, unknown>): Promise<string> {
  const mod = await loadComponent<Module>("ssr", "image");
  return renderToString(() =>
    createComponent(mod.Image as never, {
      src: "/a.png",
      width: 10,
      height: 10,
      alt: "",
      unoptimized: true,
      ...props,
    }),
  );
}

describe("<Image unoptimized> still checks what it writes", () => {
  it("[DUSK-R2-10] a width or height that is not finite and positive is a RangeError naming the prop", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number]) {
      await expect(render({ width: bad }), `width ${String(bad)}`).rejects.toThrow(/width/);
      await expect(render({ height: bad }), `height ${String(bad)}`).rejects.toThrow(/height/);
    }
  });

  it("[DUSK-R2-10] a fractional size is fine for a plain image", async () => {
    expect(await render({ width: 10.5, height: 3.25 })).toContain('width="10.5"');
  });

  it("[DUSK-R2-10] javascript:, vbscript: and other script-bearing sources are refused, however they are spelled", async () => {
    for (const src of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://host/a.png",
      "",
    ]) {
      await expect(render({ src }), JSON.stringify(src)).rejects.toThrow(TypeError);
    }
  });

  it("[DUSK-R2-10] data:image/*, blob:, http(s), and relative sources are served as given", async () => {
    for (const src of [
      "data:image/png;base64,AAAA",
      "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
      "blob:https://app.example/1234",
      "https://cdn.example/a.png",
      "http://cdn.example/a.png",
      "/a.png",
      "a.png",
      "./a.png",
      "../img/a.png",
    ]) {
      expect(await render({ src }), src).toContain("<img");
    }
  });

  it("[DUSK-R2-10] a priority unoptimized image checks the source before it is preloaded", async () => {
    await expect(render({ src: "javascript:alert(1)", priority: true })).rejects.toThrow(TypeError);
  });
});
