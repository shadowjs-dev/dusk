/**
 * Which hosts and addresses the image optimizer never connects to: loopback, private, link-local, CGNAT, reserved,
 * documentation, multicast and unique-local ranges, in every spelling a URL or a resolver can write them. Shared by the
 * route (which judges the host it is asked for) and by `safeImageFetch` (which judges what a name resolved to).
 * @packageDocumentation
 */
import { trimEndChar } from "../internal/text";

/**
 * Whether an image host is refused even when an origin pattern allows it: a literal address in a loopback, private,
 * link-local, CGNAT, reserved, documentation, multicast or unique-local range (IPv4, IPv6, and IPv4 written inside IPv6,
 * 6to4 or NAT64), `localhost` and any name under `.localhost`, `.local` or `.internal` (a trailing dot is ignored). Names
 * are not resolved here: a public name that resolves to a private address is refused at connect time by
 * `safeImageFetch` (Node), or by the platform or the egress firewall (the deploy guide says so).
 *
 * @param hostname The `hostname` of a parsed URL (an IPv6 literal keeps its brackets).
 * @returns Whether the host must not be fetched.
 * @internal
 */
export function isRefusedImageHost(hostname: string): boolean {
  // `localhost.` and `127.0.0.1.` name the same hosts as without the dot.
  const bracketless = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const host = trimEndChar(bracketless, ".");
  if (host === "") return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "local" || host.endsWith(".local")) return true;
  if (host === "internal" || host.endsWith(".internal")) return true;
  if (host.includes(":")) return refusedIPv6(host);
  const octets = IPV4.exec(host);
  return octets !== null && refusedIPv4(octets.slice(1).map(Number));
}

/**
 * Whether a resolved address (as a resolver prints it: `::ffff:127.0.0.1`, `fe80::1%en0`, `0:0:0:0:0:0:0:1`) is one the
 * optimizer never connects to. Text that is not an address is refused.
 *
 * @param address An address from a resolver.
 * @returns Whether it must not be connected to.
 * @internal
 */
export function isRefusedImageAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, "");
  if (bare.includes(":")) {
    const literal = `http://[${bare}]/`;
    // The URL parser writes every IPv6 spelling in one compressed lower-case form (and IPv4-in-IPv6 in hex).
    return !URL.canParse(literal) || isRefusedImageHost(new URL(literal).hostname);
  }
  const octets = IPV4.exec(bare);
  return octets === null || refusedIPv4(octets.slice(1).map(Number));
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The IPv4 ranges refused: "this network", private, loopback, link-local, CGNAT, protocol and documentation blocks, benchmarking, multicast and reserved. */
function refusedIPv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 text (compressed form allowed), or undefined for text that is not one. */
function ipv6Groups(host: string): number[] | undefined {
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? undefined : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** The IPv4 address held in two 16-bit groups. */
function v4Of(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/**
 * The IPv6 ranges refused: ::/96 (unspecified, loopback, IPv4-compatible), unique-local (fc00::/7), everything from fe80::
 * up (link-local, site-local, multicast), the discard prefix, Teredo and documentation space, and the three forms that carry
 * an IPv4 address (IPv4-mapped, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) when that address is refused. Text that is not an
 * address is refused.
 */
function refusedIPv6(host: string): boolean {
  const g = ipv6Groups(host);
  if (g === undefined) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::/96 and ::ffff:0:0/96. Every other `::x` is refused too (nothing public lives there).
    return g5 === 0xffff ? refusedIPv4(v4Of(g6, g7)) : true;
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? refusedIPv4(v4Of(g6, g7)) : true;
  }
  if (g0 === 0x2002) return refusedIPv4(v4Of(g1, g2));
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  return (g0 & 0xfe00) === 0xfc00 || g0 >= 0xfe80;
}
