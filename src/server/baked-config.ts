/**
 * The server part of `dusk.config.ts` as the server bundle receives it (plain JSON), and its mapping onto
 * the handler options. The build writes the JSON into the server entry; `createHandler` gets the options at
 * start, so the same validation runs in both places. Secrets are never part of it (see `vite/config-file.ts`).
 *
 * @packageDocumentation
 */

import type { LocaleRoutingSettings } from "../i18n/settings";
import type { CacheLifeProfile } from "../shared/cache-life";
import type { ImageWidths } from "../shared/image";
import type { RoutingConfig } from "../shared/routing-config";
import type { CorsOptions } from "./cors";
import type { CspOptions } from "./csp";
import { defineEnv, type EnvShape } from "./env";
import type {
  CsrfOptions,
  HandlerOptions,
  LimitsOptions,
  SecureHeadersOptions,
  SecurityOptions,
  TrustProxyOptions,
} from "./types";

/** The security settings as written in the file (no secrets). @since 1.0.0 */
export interface BakedSecurity {
  readonly allowedHosts?: readonly string[];
  readonly acknowledgeNoHostCheck?: boolean;
  readonly headers?: false | SecureHeadersOptions;
  readonly csp?: false | CspOptions;
  readonly csrf?: false | CsrfOptions;
  readonly limits?: LimitsOptions;
  readonly trustProxy?: false | TrustProxyOptions;
  readonly nonce?: boolean;
  readonly requestId?: boolean;
  readonly methodNotAllowed?: "json" | "empty";
  readonly defaultCacheControl?: string | false;
  readonly trustedOrigins?: readonly string[];
  readonly cors?: CorsOptions;
  readonly rpc?: {
    readonly maxGetPayloadChars?: number;
    readonly maxResponseBytes?: number;
    readonly maxBatchSize?: number;
  };
  readonly maxPayloadBytes?: number;
}

/** The server part of the configuration. @since 1.0.0 */
export interface BakedServerConfig {
  readonly security?: BakedSecurity;
  readonly routing?: RoutingConfig;
  readonly env?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * The locales; `routing` is present when the file declares `i18n.routing` (its settings with the defaults applied,
   * without the build-only `instance`). The generated entry hands it to `withLocaleRouting`.
   */
  readonly i18n?: {
    readonly locales: readonly string[];
    readonly defaultLocale: string;
    readonly routing?: LocaleRoutingSettings;
  };
  readonly images?: {
    readonly remotePatterns?: readonly string[];
    readonly widths?: ImageWidths;
    readonly maxWidth?: number;
    readonly formats?: readonly string[];
    readonly qualities?: readonly number[];
  };
  readonly cacheLife?: Readonly<Record<string, CacheLifeProfile>>;
  readonly draftMode?: {
    readonly secretEnv?: string;
    readonly cookieName?: string;
    readonly enablePath?: string;
    readonly disablePath?: string;
  };
  readonly deploymentId?: string;
  readonly skew: { readonly reload: boolean };
  readonly instrumentation: boolean;
}

/**
 * The handler options a baked configuration stands for. Options the entry file passes itself win over these
 * (the entry is spread after them).
 *
 * @param baked The server configuration, or `undefined` for a project without `dusk.config.ts`.
 * @returns The options to pass to `createHandler`.
 * @example
 * import { createHandler, serverOptionsFromConfig } from "@shadow-js/dusk/server";
 *
 * // `baked` is the server part of dusk.config.ts that the build wrote into the server bundle.
 * const handler = createHandler({ manifest, features, ...serverOptionsFromConfig(baked) });
 * @since 1.0.0
 */
export function serverOptionsFromConfig(
  baked: BakedServerConfig | undefined,
): Partial<HandlerOptions> {
  if (baked === undefined) return {};
  const options: {
    security?: SecurityOptions;
    trustedOrigins?: readonly string[];
    rpc?: BakedSecurity["rpc"];
    maxPayloadBytes?: number;
    routing?: RoutingConfig;
    env?: ReturnType<typeof defineEnv>;
    i18n?: { readonly locales: readonly string[]; readonly defaultLocale: string };
    images?: {
      remotePatterns?: readonly string[];
      widths?: ImageWidths;
      maxWidth?: number;
      formats?: readonly string[];
      qualities?: readonly number[];
    };
    cacheLife?: BakedServerConfig["cacheLife"];
    draft?: BakedServerConfig["draftMode"];
    deploymentId?: string;
  } = {};
  const security = baked.security;
  if (security !== undefined) {
    const { trustedOrigins, rpc, maxPayloadBytes, ...rest } = security;
    options.security = rest;
    if (trustedOrigins !== undefined) options.trustedOrigins = trustedOrigins;
    if (rpc !== undefined) options.rpc = rpc;
    if (maxPayloadBytes !== undefined) options.maxPayloadBytes = maxPayloadBytes;
  }
  if (baked.routing !== undefined) options.routing = baked.routing;
  if (baked.env !== undefined) options.env = defineEnv(baked.env as unknown as EnvShape);
  // The handler reads the locales (the default `<html lang>`); the routing settings go to `withLocaleRouting`.
  if (baked.i18n !== undefined)
    options.i18n = { locales: baked.i18n.locales, defaultLocale: baked.i18n.defaultLocale };
  if (baked.images !== undefined) options.images = baked.images;
  if (baked.cacheLife !== undefined) options.cacheLife = baked.cacheLife;
  if (baked.draftMode !== undefined) options.draft = baked.draftMode;
  if (baked.deploymentId !== undefined) options.deploymentId = baked.deploymentId;
  return options as Partial<HandlerOptions>;
}
