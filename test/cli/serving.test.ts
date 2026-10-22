import { describe, expect, it } from "vitest";
import { localUrl } from "../../src/cli/serving";

describe("the URL a startup banner shows", () => {
  it("[DSK-W-12] a wildcard listener is shown as 127.0.0.1, which answers whatever localhost resolves to", () => {
    // On Windows `localhost` can resolve to ::1 first while an IPv4-only listener answers on 127.0.0.1 alone.
    expect(localUrl("0.0.0.0", 3000)).toBe("http://127.0.0.1:3000/");
    expect(localUrl("", 3000)).toBe("http://127.0.0.1:3000/");
    expect(localUrl("::", 3000)).toBe("http://127.0.0.1:3000/");
  });

  it("[DSK-W-13] an IPv6 address is shown in brackets, and a named or IPv4 host is shown as it is", () => {
    expect(localUrl("::1", 3000)).toBe("http://[::1]:3000/");
    expect(localUrl("fe80::1", 3000)).toBe("http://[fe80::1]:3000/");
    expect(localUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000/");
    expect(localUrl("localhost", 3000)).toBe("http://localhost:3000/");
  });
});
