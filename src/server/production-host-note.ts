/**
 * The production note about an unset `security.allowedHosts`. It lives in its own module, loaded with `import()` on the
 * first production request that needs it (see `createHandler`), so the text is not part of the handler's start-up code.
 *
 * @returns The one-line note, which names the option and the two ways out.
 * @internal
 */
export function productionHostNote(): string {
  return 'security.allowedHosts is not set in production: the Host header is attacker input. List the host names this server answers for (for example security.allowedHosts: ["example.com"]). To accept any Host on purpose, set allowedHosts: [] and acknowledgeNoHostCheck: true.';
}
