/** Where variables are read from. @since 1.0.0 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

interface FieldBase {
  /** A missing variable is an error unless this is `false` or a `default` is given. */
  readonly required?: boolean;
  /**
   * Marks a value that must never reach a client. A variable with a public prefix (`DUSK_PUBLIC_`, or one of
   * `defineEnv`'s `publicPrefixes`) cannot be secret: it is public by its name.
   */
  readonly secret?: boolean;
}

/** Options of {@link defineEnv}. @since 1.0.0 */
export interface EnvOptions {
  /**
   * The public prefixes of the app beyond `DUSK_PUBLIC_` (the same list as `env.public.prefixes` in `dusk.config.ts`). A
   * name with one of them is public: it is in `parsed.public` unless it is secret. The typed `parsed.public` covers the
   * `DUSK_PUBLIC_` names only; the others are read from the same object.
   */
  readonly publicPrefixes?: readonly string[];
}

/** A text variable. @since 1.0.0 */
export interface StringField extends FieldBase {
  readonly type: "string";
  readonly default?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
}
/** A numeric variable. @since 1.0.0 */
export interface NumberField extends FieldBase {
  readonly type: "number";
  readonly default?: number;
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
}
/** A boolean variable: `true/false`, `1/0`, `yes/no`, `on/off`. @since 1.0.0 */
export interface BooleanField extends FieldBase {
  readonly type: "boolean";
  readonly default?: boolean;
}
/** A URL variable; the value is the normalized href. @since 1.0.0 */
export interface UrlField extends FieldBase {
  readonly type: "url";
  readonly default?: string;
  /** Accepted schemes, with the colon. Default `["http:", "https:"]`. */
  readonly protocols?: readonly string[];
}
/** A variable that is one of a fixed set. @since 1.0.0 */
export interface EnumField<V extends string = string> extends FieldBase {
  readonly type: "enum";
  readonly values: readonly V[];
  readonly default?: V;
}

/** A variable description. @since 1.0.0 */
export type EnvField = StringField | NumberField | BooleanField | UrlField | EnumField;

/** Variable name to description. @since 1.0.0 */
export type EnvShape = Readonly<Record<string, EnvField>>;

type FieldValue<F> = F extends { readonly type: "string" }
  ? string
  : F extends { readonly type: "number" }
    ? number
    : F extends { readonly type: "boolean" }
      ? boolean
      : F extends { readonly type: "url" }
        ? string
        : F extends { readonly type: "enum"; readonly values: readonly (infer V)[] }
          ? V
          : never;

type Resolved<F> = F extends { readonly default: unknown }
  ? FieldValue<F>
  : F extends { readonly required: false }
    ? FieldValue<F> | undefined
    : FieldValue<F>;

/**
 * The validated variables. `all` holds every variable of the schema; `public` only those named
 * `DUSK_PUBLIC_*`, the only ones a client bundle may see.
 * @since 1.0.0
 */
export interface ParsedEnv<S extends EnvShape = EnvShape> {
  readonly all: string extends keyof S
    ? Readonly<Record<string, unknown>>
    : { readonly [K in keyof S]: Resolved<S[K]> };
  readonly public: string extends keyof S
    ? Readonly<Record<string, unknown>>
    : { readonly [K in keyof S as K extends `DUSK_PUBLIC_${string}` ? K : never]: Resolved<S[K]> };
}

/** A validated environment description. @since 1.0.0 */
export interface EnvSchema<S extends EnvShape = EnvShape> {
  readonly shape: S;
  /**
   * Validates `source`.
   * @throws EnvError listing every invalid variable by name (never by value).
   */
  parse(source: EnvSource): ParsedEnv<S>;
}

/** One invalid variable. @since 1.0.0 */
export interface EnvIssue {
  readonly key: string;
  readonly message: string;
}

/**
 * Thrown at startup when the environment does not match its schema. The message names the
 * variables and the problem, never the values, so it is safe to log.
 * @example
 * try { env.parse({}); } catch (error) { if (error instanceof EnvError) console.log(error.issues); }
 * @since 1.0.0
 */
export class EnvError extends Error {
  readonly issues: readonly EnvIssue[];

  /** @param issues Every problem found. */
  constructor(issues: readonly EnvIssue[]) {
    super(
      `Invalid environment: ${issues.map((issue) => `${issue.key} (${issue.message})`).join(", ")}`,
    );
    this.name = "EnvError";
    this.issues = issues;
  }
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);
const PUBLIC_PREFIX = "DUSK_PUBLIC_";
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses one variable; returns the value or the problem. */
function parseField(raw: string, field: EnvField): { value: unknown } | { problem: string } {
  switch (field.type) {
    case "string": {
      if (field.minLength !== undefined && raw.length < field.minLength) {
        return { problem: `shorter than ${field.minLength} characters` };
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return { problem: `longer than ${field.maxLength} characters` };
      }
      if (field.pattern !== undefined && !field.pattern.test(raw))
        return { problem: "does not match the pattern" };
      return { value: raw };
    }
    case "number": {
      const value = raw.trim() === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) return { problem: "expected a number" };
      if (field.integer === true && !Number.isInteger(value))
        return { problem: "expected an integer" };
      if (field.min !== undefined && value < field.min) return { problem: `below ${field.min}` };
      if (field.max !== undefined && value > field.max) return { problem: `above ${field.max}` };
      return { value };
    }
    case "boolean": {
      const lower = raw.trim().toLowerCase();
      if (TRUE.has(lower)) return { value: true };
      if (FALSE.has(lower)) return { value: false };
      return { problem: "expected true or false" };
    }
    case "url": {
      if (!URL.canParse(raw)) return { problem: "expected a URL" };
      const url = new URL(raw);
      const protocols = field.protocols ?? ["http:", "https:"];
      if (!protocols.includes(url.protocol))
        return { problem: `expected a ${protocols.join(" or ")} URL` };
      return { value: url.href };
    }
    case "enum": {
      if (!field.values.includes(raw))
        return { problem: `expected one of ${field.values.join(", ")}` };
      return { value: raw };
    }
  }
}

/**
 * Describes the environment of the app. The handler validates it at startup, so a missing secret
 * stops the server before it serves a request. Variables named `DUSK_PUBLIC_*` are the only ones a
 * client bundle may read; everything else is server-only.
 *
 * @param shape Variable name to description.
 * @param options The app's public prefixes (`env.public.prefixes` of `dusk.config.ts`), beside `DUSK_PUBLIC_`.
 * @returns The schema; pass it as `createHandler({ env })` or call `parse` yourself.
 * @throws TypeError for an invalid name, or a field marked `secret` whose name has a public prefix (`[ENV_SECRET_PUBLIC]`).
 *   The schema module runs on the server only: the build does not evaluate it, so this check runs when the module loads.
 * @example
 * const env = defineEnv({
 *   DATABASE_URL: { type: "url", protocols: ["postgres:"] },
 *   PORT: { type: "number", integer: true, default: 3000 },
 *   DUSK_PUBLIC_API_URL: { type: "url" },
 * }, { publicPrefixes: ["NEXT_PUBLIC_"] });
 * @since 1.0.0
 */
export function defineEnv<const S extends EnvShape>(
  shape: S,
  options: EnvOptions = {},
): EnvSchema<S> {
  const publicPrefixes = [PUBLIC_PREFIX, ...(options.publicPrefixes ?? [])];
  const isPublicName = (key: string): boolean =>
    publicPrefixes.some((prefix) => key.startsWith(prefix));
  for (const [key, field] of Object.entries(shape)) {
    if (!KEY.test(key))
      throw new TypeError(`environment variable name ${JSON.stringify(key)} is invalid.`);
    if (isPublicName(key) && field.secret === true) {
      throw new TypeError(
        `[ENV_SECRET_PUBLIC] ${key} has a public prefix, so the browser may read it, and cannot be secret. Rename it, or drop secret: true.`,
      );
    }
  }
  return {
    shape,
    parse(source) {
      const all: Record<string, unknown> = {};
      const publicValues: Record<string, unknown> = {};
      const issues: EnvIssue[] = [];
      for (const [key, field] of Object.entries(shape)) {
        const raw = Object.hasOwn(source, key) ? source[key] : undefined;
        let value: unknown;
        if (raw === undefined || raw === "") {
          if (field.default !== undefined) value = field.default;
          else if (field.required === false) value = undefined;
          else {
            issues.push({ key, message: "required" });
            continue;
          }
        } else {
          const parsed = parseField(raw, field);
          if ("problem" in parsed) {
            issues.push({ key, message: parsed.problem });
            continue;
          }
          value = parsed.value;
        }
        all[key] = value;
        // Public names only, and never a secret (defineEnv refuses that combination; this keeps the rule in one place).
        if (isPublicName(key) && field.secret !== true) publicValues[key] = value;
      }
      if (issues.length > 0) throw new EnvError(issues);
      // The mapped type is exact for the literal shape; the runtime object has exactly those keys.
      return Object.freeze({
        all: Object.freeze(all),
        public: Object.freeze(publicValues),
      }) as unknown as ParsedEnv<S>;
    },
  };
}
