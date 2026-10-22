import type { TrustProxyOptions } from "./types";

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Parses an IPv6 address into eight 16-bit groups, or `undefined` when it is not valid. */
function parseIpv6(text: string): number[] | undefined {
  let source = text;
  const zone = source.indexOf("%");
  if (zone !== -1) source = source.slice(0, zone);
  if (source.length < 2 || !/^[0-9a-fA-F:.]+$/.test(source)) return undefined;
  const doubleAt = source.indexOf("::");
  if (doubleAt !== source.lastIndexOf("::")) return undefined;
  const groupsOf = (part: string): number[] | undefined => {
    if (part === "") return [];
    const result: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        // An embedded IPv4 address is only valid as the last piece and counts as two groups.
        if (index !== pieces.length - 1 || !IPV4.test(piece)) return undefined;
        const octets = piece.split(".").map(Number);
        result.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
        result.push(Number.parseInt(piece, 16));
      }
    }
    return result;
  };
  if (doubleAt === -1) {
    const all = groupsOf(source);
    return all !== undefined && all.length === 8 ? all : undefined;
  }
  const head = groupsOf(source.slice(0, doubleAt));
  const tail = groupsOf(source.slice(doubleAt + 2));
  if (head === undefined || tail === undefined || head.length + tail.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * Normalizes an IP address: IPv4 stays as is, IPv6 is written in full lower-case groups, and an
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) becomes the IPv4 address. Brackets and a port
 * (`[::1]:80`, `1.2.3.4:80`) are removed.
 *
 * @param value Text from a socket or a header.
 * @returns The normalized address, or `undefined` when `value` is not an IP address.
 * @example
 * normalizeIp("::FFFF:10.0.0.1"); // "10.0.0.1"
 * @since 1.0.0
 */
export function normalizeIp(value: string): string | undefined {
  let text = value.trim();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return undefined;
    text = text.slice(1, close);
  } else if (text.indexOf(":") !== -1 && text.indexOf(":") === text.lastIndexOf(":")) {
    text = text.slice(0, text.indexOf(":"));
  }
  if (IPV4.test(text)) return text;
  const groups = parseIpv6(text);
  if (groups === undefined) return undefined;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return groups.map((group) => group.toString(16).padStart(4, "0")).join(":");
}

/**
 * The key a rate limiter should use for an address. IPv6 clients usually own a whole /64, so the
 * key keeps only that prefix (otherwise one client could rotate through 2^64 addresses).
 *
 * @param address A normalized address.
 * @param ipv6Prefix Bits of an IPv6 address to keep: 64 (default) or 128.
 * @returns The key.
 * @example
 * addressKey("2001:db8:1:2::9"); // "2001:0db8:0001:0002::/64" for a normalized address
 * @since 1.0.0
 */
export function addressKey(address: string, ipv6Prefix: 64 | 128 = 64): string {
  if (!address.includes(":") || ipv6Prefix === 128) return address;
  return `${address.split(":").slice(0, 4).join(":")}::/64`;
}

/**
 * Chooses the client address. Without proxy trust it is the peer address. With it, the header is
 * read from the right (the closest proxy appends last) skipping `hops - 1` entries; an invalid or
 * missing entry falls back to the peer, so a spoofed header cannot produce a non-address key.
 *
 * @param peer The address of the TCP peer, as the host reports it.
 * @param headers Request headers.
 * @param trust The trust configuration.
 * @returns The address, or `undefined` when nothing usable exists.
 * @example
 * resolveClientAddress("10.0.0.2", request.headers, { hops: 1 });
 * @since 1.0.0
 */
export function resolveClientAddress(
  peer: string | undefined,
  headers: Headers,
  trust: false | TrustProxyOptions | undefined,
): string | undefined {
  const peerAddress = peer === undefined ? undefined : normalizeIp(peer);
  if (trust === undefined || trust === false) return peerAddress;
  if (trust.trustedPeers !== undefined) {
    const trusted = trust.trustedPeers.map((entry) => normalizeIp(entry));
    if (peerAddress === undefined || !trusted.includes(peerAddress)) return peerAddress;
  }
  const value = headers.get(trust.header ?? "x-forwarded-for");
  if (value === null) return peerAddress;
  const entries = value.split(",").map((entry) => entry.trim());
  const hops = Math.max(1, trust.hops ?? 1);
  const chosen = entries[entries.length - hops];
  const normalized = chosen === undefined ? undefined : normalizeIp(chosen);
  return normalized ?? peerAddress;
}
