import { allowedHostsOf, compileHostRules } from "./hosts";

/**
 * The host check a static file layer applies before it answers a file: the same predicate the handler applies to
 * `url.host` (`security.allowedHosts`, compiled by {@link compileHostRules}). It is built from the handler's own
 * `allowedHosts` list, so the two cannot disagree. A handler with no host list gets `undefined`, and the static layer
 * then does no host work at all (the pure-file path).
 *
 * This module is not imported by the handler, so it adds nothing to the handler's bundle.
 *
 * @param handler Any handler object (a `createHandler` result exposes `allowedHosts`).
 * @returns The predicate over `url.host`, or `undefined` when the handler accepts any host.
 * @internal
 */
export function hostCheckOf(handler: object): ((host: string) => boolean) | undefined {
  const hosts = allowedHostsOf(handler);
  return hosts === undefined ? undefined : compileHostRules(hosts);
}
