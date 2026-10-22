import { networkInterfaces } from "node:os";
import { isRecord } from "../shared/check";
import type { DuskCoreApi } from "../vite/plugin";
import { CliError } from "./errors";

/**
 * Port and host values shared by `dev` and `start`: how a text value becomes a port, the environment variables
 * `PORT` and `HOST`, and the local URL a banner shows.
 *
 * @packageDocumentation
 */

/**
 * A port from its text: a whole number from 0 to 65535 (0 asks the system for a free one).
 * @param text The text of the flag or variable.
 * @returns The port, or undefined when the text is not a port.
 * @since 1.0.0
 */
export function portNumber(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}

/**
 * The port of an environment variable. An empty or unset variable is no port.
 * @param name The variable name, for the message.
 * @param value Its value.
 * @returns The port, or undefined when the variable is unset.
 * @throws CliError when the value is not a port.
 * @since 1.0.0
 */
export function portFromEnv(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = portNumber(value);
  if (port === undefined)
    throw new CliError(
      `${name} must be a port number from 0 to 65535 (got "${value}")`,
      "DUSK_INVALID_PORT",
    );
  return port;
}

/**
 * The host of an environment variable. An empty or unset variable is no host.
 * @param value The value of `HOST`.
 * @returns The host, or undefined.
 * @since 1.0.0
 */
export function hostFromEnv(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The URL a banner shows for a server listening on `host` and `port`. A wildcard address (every interface) is shown
 * as `127.0.0.1`: `localhost` may resolve to `::1` first on Windows, where an IPv4 listener then looks dead. An IPv6
 * address is shown in brackets, which is what a URL needs.
 * @param host The interface the server listens on.
 * @param port The port in use.
 * @returns `http://host:port/`.
 * @example localUrl("0.0.0.0", 3000); // "http://127.0.0.1:3000/"
 * @since 1.0.0
 */
export function localUrl(host: string, port: number): string {
  const wildcard = host === "" || host === "0.0.0.0" || host === "::";
  const shown = wildcard ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}/`;
}

/** True for an address that only this machine can reach (`localhost`, `127.x`, `::1`). @since 1.0.0 */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * The URLs a server on `host:port` answers on the network. A wildcard address is every IPv4 address of this machine; a
 * loopback address is none (the server is not on the network); another address is that one.
 * @param host The interface the server listens on.
 * @param port The port in use.
 * @returns The URLs (possibly none).
 * @since 1.0.0
 */
export function networkUrlsFor(host: string, port: number): string[] {
  if (host === "" || host === "0.0.0.0" || host === "::") {
    const urls: string[] = [];
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal)
          urls.push(`http://${address.address}:${port}/`);
      }
    }
    return urls;
  }
  return isLoopback(host) ? [] : [localUrl(host, port)];
}

/**
 * The Dusk API of the core plugin in a Vite config's plugin list, or undefined when the plugin is not there.
 * @param plugins The plugins (`server.config.plugins` or `builder.config.plugins`).
 * @returns The API, typed.
 * @since 1.0.0
 */
export function duskApiOf(plugins: readonly unknown[]): DuskCoreApi | undefined {
  for (const plugin of plugins) {
    if (!isRecord(plugin) || Reflect.get(plugin, "name") !== "shadowjs:start") continue;
    const api = Reflect.get(plugin, "api");
    if (isDuskApi(api)) return api;
  }
  return undefined;
}

function isDuskApi(value: unknown): value is DuskCoreApi {
  return isRecord(value) && typeof Reflect.get(value, "getServerFns") === "function";
}
