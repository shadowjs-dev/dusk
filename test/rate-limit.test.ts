import { describe, expect, it } from "vitest";
import {
  addressKey,
  createMemoryRateLimitStore,
  createRateLimiter,
  normalizeIp,
} from "../src/server/index";

describe("token bucket", () => {
  it("[SRLM-01] allows the burst, then refuses with the time until a token is back", async () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 2, now: () => now });
    for (let n = 2; n >= 0; n -= 1)
      expect(await limiter.check("k")).toMatchObject({ allowed: true, remaining: n });
    expect(await limiter.check("k")).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: 500,
    });
    now += 500;
    expect(await limiter.check("k")).toMatchObject({ allowed: true });
  });

  it("[SRLM-02] refills at the configured rate and never above capacity", async () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 1, now: () => now });
    await limiter.check("k", 5);
    now += 2000;
    expect((await limiter.check("k")).remaining).toBe(1);
    now += 3_600_000;
    expect((await limiter.check("k")).remaining).toBe(4);
  });

  it("[SRLM-03] keys are independent; a cost larger than the capacity is never allowed", async () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 });
    await limiter.check("a", 2);
    expect((await limiter.check("a")).allowed).toBe(false);
    expect((await limiter.check("b")).allowed).toBe(true);
    expect((await limiter.check("c", 3)).allowed).toBe(false);
  });

  it("[SRLM-04] bound: the memory store holds at most maxKeys buckets, evicting the least recently used", async () => {
    const store = createMemoryRateLimitStore({ maxKeys: 4 });
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, store, now: () => 0 });
    for (let n = 0; n < 100; n += 1) await limiter.check(`ip-${String(n)}`);
    expect(store.size).toBe(4);
    // An evicted key starts over with a full bucket; a live key is still limited.
    expect((await limiter.check("ip-99")).allowed).toBe(false);
    expect((await limiter.check("ip-0")).allowed).toBe(true);
  });

  it("[SRLM-05] a custom store is used and namespaced by name", async () => {
    const seen: string[] = [];
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      name: "login",
      store: {
        take: (key) => {
          seen.push(key);
          return { allowed: true, remaining: 0, retryAfterMs: 0, resetMs: 0 };
        },
      },
    });
    await limiter.check("1.2.3.4");
    expect(seen).toEqual(["login:1.2.3.4"]);
  });

  it("[SRLM-06] invalid parameters are refused", () => {
    expect(() => createRateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
    expect(() => createMemoryRateLimitStore({ maxKeys: 0 })).toThrow(RangeError);
  });
});

describe("client addresses", () => {
  it("[SRLM-10] IPv4, IPv6, IPv4-mapped, ports and brackets normalize; non-addresses are refused", () => {
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(normalizeIp("[2001:DB8::ff]:443")).toBe("2001:0db8:0000:0000:0000:0000:0000:00ff");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0000:0000:0000:0000:0000:0000:0001");
    for (const bad of [
      "",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "01.2.3.4",
      "::g",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "evil.test",
      "1.2.3.4, 5.6.7.8",
      "[::1",
    ]) {
      expect(normalizeIp(bad), bad).toBeUndefined();
    }
  });

  it("[SRLM-11] an IPv6 client is keyed by its /64, so rotating the interface part does not escape the limit", () => {
    const a = normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd") ?? "";
    const b = normalizeIp("2001:db8:1:2:1111:2222:3333:4444") ?? "";
    expect(addressKey(a)).toBe(addressKey(b));
    expect(addressKey(a, 128)).not.toBe(addressKey(b, 128));
    expect(addressKey("1.2.3.4")).toBe("1.2.3.4");
  });
});
