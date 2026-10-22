import { describe, expect, it } from "vitest";
import { scriptsHtml, scriptTag } from "../../src/shared/script";

/**
 * `scriptTag` is the markup of a `<Script>`: its strategy decides where and when it runs, and every
 * script carries the request's CSP nonce, so a policy with `script-src 'nonce-…'` allows it and nothing else.
 */
describe("scriptTag", () => {
  it("[SCR-01] beforeInteractive is a blocking script in the head, with the nonce of the response", () => {
    expect(scriptTag({ src: "/polyfill.js", strategy: "beforeInteractive", nonce: "abc123" })).toBe(
      '<script src="/polyfill.js" nonce="abc123"></script>',
    );
  });

  it("[SCR-02] afterInteractive is async: it does not block the parser or the hydration", () => {
    expect(
      scriptTag({
        src: "https://cdn.example/analytics.js",
        strategy: "afterInteractive",
        nonce: "n",
      }),
    ).toBe('<script src="https://cdn.example/analytics.js" async nonce="n"></script>');
  });

  it("[SCR-03] lazyOnload writes nothing in the markup: the browser loads it after the load event (loadScript)", () => {
    expect(scriptTag({ src: "/chat-widget.js", strategy: "lazyOnload", nonce: "n" })).toBe("");
  });

  it("[SCR-04] a source that is not a path or an http(s) URL is refused, and attribute values are escaped", () => {
    expect(() => scriptTag({ src: "javascript:alert(1)", strategy: "afterInteractive" })).toThrow(
      TypeError,
    );
    expect(() =>
      scriptTag({ src: "data:text/javascript,alert(1)", strategy: "afterInteractive" }),
    ).toThrow(TypeError);
    expect(() => scriptTag({ src: "//evil.example/x.js", strategy: "afterInteractive" })).toThrow(
      TypeError,
    );
    expect(scriptTag({ src: '/a.js?x="1"&y=<2>', strategy: "beforeInteractive" })).toBe(
      '<script src="/a.js?x=&quot;1&quot;&amp;y=&lt;2&gt;"></script>',
    );
  });

  it("[SCR-05] the nonce is a token: a value with quotes or spaces is refused", () => {
    expect(() =>
      scriptTag({ src: "/a.js", strategy: "beforeInteractive", nonce: 'x" onload="y' }),
    ).toThrow(TypeError);
  });
});

describe("scriptsHtml", () => {
  it("[SCR-06] the head scripts are in strategy order, each source once, and lazyOnload ones are left out", () => {
    const html = scriptsHtml(
      [
        { src: "/late.js", strategy: "afterInteractive" },
        { src: "/first.js", strategy: "beforeInteractive" },
        { src: "/late.js", strategy: "afterInteractive" },
        { src: "/later.js", strategy: "lazyOnload" },
      ],
      "n0",
    );
    expect(html).toBe(
      '<script src="/first.js" nonce="n0"></script><script src="/late.js" async nonce="n0"></script>',
    );
  });
});
