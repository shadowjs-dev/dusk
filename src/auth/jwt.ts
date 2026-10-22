import { base64UrlDecode, utf8 } from "../internal/encoding";
import { OidcError } from "./errors";

/**
 * The signature algorithms this package verifies, all through WebCrypto. `none` is not among them and cannot be added.
 * @since 1.0.0
 */
export type JwsAlgorithm =
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA"
  | "HS256"
  | "HS384"
  | "HS512";

/** The header of a JWT, as far as verification reads it. @since 1.0.0 */
export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

/** A JSON Web Key (RFC 7517), the fields verification reads. @since 1.0.0 */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly key_ops?: readonly string[];
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

/** A parsed JWT whose signature has not been checked yet. @internal */
export interface DecodedJwt {
  readonly header: JwtHeader;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signingInput: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

/** The result of {@link verifyJwt}: a token whose signature verified. @since 1.0.0 */
export interface VerifiedJwt {
  readonly header: JwtHeader;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface AlgorithmSpec {
  readonly kty: "RSA" | "EC" | "OKP" | "oct";
  readonly importAlgorithm:
    | RsaHashedImportParams
    | EcKeyImportParams
    | Algorithm
    | HmacImportParams;
  readonly verifyAlgorithm: Algorithm | RsaPssParams | EcdsaParams;
  /** Raw signature length in bytes for ECDSA. */
  readonly signatureLength?: number;
  /** The `crv` the key must have. */
  readonly curve?: string;
}

const BITS = ["256", "384", "512"] as const;
const SPECS = new Map<string, AlgorithmSpec>();
for (const bits of BITS) {
  const hash = `SHA-${bits}`;
  SPECS.set(`RS${bits}`, {
    kty: "RSA",
    importAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash },
    verifyAlgorithm: { name: "RSASSA-PKCS1-v1_5" },
  });
  SPECS.set(`PS${bits}`, {
    kty: "RSA",
    importAlgorithm: { name: "RSA-PSS", hash },
    verifyAlgorithm: { name: "RSA-PSS", saltLength: Number(bits) / 8 },
  });
  SPECS.set(`HS${bits}`, {
    kty: "oct",
    importAlgorithm: { name: "HMAC", hash },
    verifyAlgorithm: { name: "HMAC" },
  });
}
for (const [alg, curve, length, hash] of [
  ["ES256", "P-256", 64, "SHA-256"],
  ["ES384", "P-384", 96, "SHA-384"],
  ["ES512", "P-521", 132, "SHA-512"],
] as const) {
  SPECS.set(alg, {
    kty: "EC",
    importAlgorithm: { name: "ECDSA", namedCurve: curve },
    verifyAlgorithm: { name: "ECDSA", hash },
    signatureLength: length,
    curve,
  });
}
SPECS.set("EdDSA", {
  kty: "OKP",
  importAlgorithm: { name: "Ed25519" },
  verifyAlgorithm: { name: "Ed25519" },
  signatureLength: 64,
  curve: "Ed25519",
});

/** Most bytes of a token this package parses. @internal */
export const MAX_JWT_LENGTH = 65_536;
/** Smallest RSA modulus accepted, in bits. */
const MIN_RSA_BITS = 2048;

const invalid = (detail: string, cause?: unknown): OidcError =>
  new OidcError("OIDC_ID_TOKEN_INVALID", detail, cause === undefined ? {} : { cause });

/** True for an algorithm this package can verify. @internal */
export function isSupportedAlgorithm(value: string): value is JwsAlgorithm {
  return SPECS.has(value);
}

/** True for an HMAC algorithm (`HS256`, `HS384`, `HS512`). @internal */
export function isHmacAlgorithm(value: string): boolean {
  return value.startsWith("HS");
}

/** The key type (`kty`) an algorithm needs. @internal */
export function keyTypeOf(alg: string): string | undefined {
  return SPECS.get(alg)?.kty;
}

const decodeSegment = (segment: string, what: string): Uint8Array<ArrayBuffer> => {
  const bytes = base64UrlDecode(segment);
  if (bytes === undefined) throw invalid(`The ${what} of the token is not base64url.`);
  return bytes;
};

const decodeObject = (segment: string, what: string): Record<string, unknown> => {
  const bytes = decodeSegment(segment, what);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw invalid(`The ${what} of the token is not JSON.`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`The ${what} of the token is not a JSON object.`);
  }
  return value as Record<string, unknown>;
};

/**
 * Splits and parses a compact JWT. The signature is not checked here.
 * @internal
 */
export function decodeJwt(token: string): DecodedJwt {
  if (token.length > MAX_JWT_LENGTH) throw invalid("The token is too large.");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    throw invalid("The token is not a compact JWS (three non-empty parts).");
  }
  const [head, body, signature] = parts as [string, string, string];
  const header = decodeObject(head, "header");
  if (typeof header["alg"] !== "string" || header["alg"] === "") {
    throw invalid("The token header has no algorithm.");
  }
  // No extension is implemented, so a token that insists on one (RFC 7515 section 4.1.11) is refused, and so is a
  // compressed payload. `jku`, `jwk` and `x5u` are never read: keys come only from the configured JWKS.
  if ("crit" in header || "zip" in header) {
    throw invalid("The token header uses an extension this client does not implement.");
  }
  if ("kid" in header && typeof header["kid"] !== "string") {
    throw invalid("The token header has a key id that is not a string.");
  }
  return {
    header: header as unknown as JwtHeader,
    payload: decodeObject(body, "payload"),
    signingInput: utf8(`${head}.${body}`),
    signature: decodeSegment(signature, "signature"),
  };
}

/** Narrows a JWK to the fields WebCrypto needs, after the checks that make it fit `alg`. */
function keyData(jwk: Jwk, alg: string, spec: AlgorithmSpec): JsonWebKey {
  if (jwk.kty !== spec.kty) throw invalid(`The key type ${String(jwk.kty)} does not fit ${alg}.`);
  if (jwk.alg !== undefined && jwk.alg !== alg)
    throw invalid("The key is meant for another algorithm.");
  if (jwk.use !== undefined && jwk.use !== "sig") throw invalid("The key is not a signature key.");
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes("verify")) {
    throw invalid("The key does not allow verification.");
  }
  if (spec.kty === "RSA") {
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string")
      throw invalid("The RSA key is incomplete.");
    const modulus = base64UrlDecode(jwk.n);
    if (modulus === undefined) throw invalid("The RSA key is not base64url.");
    let leading = 0;
    while (leading < modulus.length && modulus[leading] === 0) leading += 1;
    if ((modulus.length - leading) * 8 < MIN_RSA_BITS)
      throw invalid("The RSA key is shorter than 2048 bits.");
    return { kty: "RSA", n: jwk.n, e: jwk.e, ext: true };
  }
  if (typeof jwk.x !== "string" || jwk.crv !== spec.curve)
    throw invalid("The key curve does not fit the algorithm.");
  if (spec.kty === "EC") {
    if (typeof jwk.y !== "string") throw invalid("The EC key is incomplete.");
    return { kty: "EC", crv: spec.curve as string, x: jwk.x, y: jwk.y, ext: true };
  }
  return { kty: "OKP", crv: spec.curve as string, x: jwk.x, ext: true };
}

/**
 * Imports a public JWK for verification with `alg`. The key must fit the algorithm (type, curve, `use`, `key_ops`,
 * `alg`), and an RSA modulus under 2048 bits is refused.
 *
 * @param jwk The key.
 * @param alg The algorithm of the token that will be checked.
 * @returns A verify-only key.
 * @throws OidcError `OIDC_ID_TOKEN_INVALID` when the key does not fit; `OIDC_UNSUPPORTED` when the runtime lacks the algorithm.
 * @example
 * const key = await importVerificationKey(jwk, "RS256");
 * @since 1.0.0
 */
export async function importVerificationKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
  const spec = SPECS.get(alg);
  if (spec === undefined || spec.kty === "oct")
    throw invalid("The algorithm needs another kind of key.");
  const data = keyData(jwk, alg, spec);
  try {
    return await crypto.subtle.importKey("jwk", data, spec.importAlgorithm, false, ["verify"]);
  } catch (error) {
    if (alg === "EdDSA" && error instanceof DOMException && error.name === "NotSupportedError") {
      throw new OidcError(
        "OIDC_UNSUPPORTED",
        "This runtime cannot verify EdDSA (Ed25519) signatures.",
        {
          cause: error,
        },
      );
    }
    throw invalid("The key could not be imported.", error);
  }
}

/**
 * Imports a shared secret as an HMAC key (OpenID Connect Core section 10.1: the client secret signs the ID token of a
 * confidential client that registered `HS256`).
 * @internal
 */
export function importHmacKey(secret: string, alg: string): Promise<CryptoKey> {
  const spec = SPECS.get(alg);
  if (spec?.kty !== "oct") throw invalid("Not an HMAC algorithm.");
  return crypto.subtle.importKey("raw", utf8(secret), spec.importAlgorithm, false, ["verify"]);
}

/** Options of {@link verifyJwt}. @since 1.0.0 */
export interface VerifyJwtOptions {
  /** Algorithms accepted. A token with another `alg` is refused before any key is looked up. */
  readonly algorithms: readonly JwsAlgorithm[];
  /** Finds the key for a header: the JWKS cache for public-key algorithms. */
  readonly key: (header: JwtHeader) => Promise<CryptoKey>;
}

/**
 * Checks the signature of a compact JWT with WebCrypto. Only the header and the signature are looked at: the claims
 * (`iss`, `aud`, `exp`, ...) are the caller's to check, and an ID token is checked by the OIDC client.
 *
 * Refused before any key is used: a token with more or fewer than three parts, a `crit` or `zip` header, an `alg` outside
 * `algorithms` (so `none` and an unexpected `HS256` never get through), and an ECDSA or EdDSA signature of the wrong length.
 *
 * @param token The compact token.
 * @param options The accepted algorithms and the key source.
 * @returns The header and payload of a token whose signature is valid.
 * @throws OidcError `OIDC_ID_TOKEN_INVALID` for a token that is malformed, uses a refused algorithm or does not verify.
 * @example
 * const { payload } = await verifyJwt(token, { algorithms: ["RS256"], key: () => publicKey });
 * @since 1.0.0
 */
export async function verifyJwt(token: string, options: VerifyJwtOptions): Promise<VerifiedJwt> {
  const decoded = decodeJwt(token);
  const alg = decoded.header.alg;
  const spec = SPECS.get(alg);
  if (spec === undefined || !(options.algorithms as readonly string[]).includes(alg)) {
    throw invalid("The token algorithm is not accepted.");
  }
  if (spec.signatureLength !== undefined && decoded.signature.length !== spec.signatureLength) {
    throw invalid("The signature has the wrong length for its algorithm.");
  }
  const key = await options.key(decoded.header);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      spec.verifyAlgorithm,
      key,
      decoded.signature,
      decoded.signingInput,
    );
  } catch (error) {
    throw invalid("The signature could not be checked.", error);
  }
  if (!valid) throw invalid("The signature does not verify.");
  return { header: decoded.header, payload: decoded.payload };
}
