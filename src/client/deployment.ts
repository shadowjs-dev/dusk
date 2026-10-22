/**
 * Deployment skew on the client. The page knows the deployment id of the build that served it. Every server
 * function call carries it in `x-dusk-deployment`; the server answers a call from another deployment with
 * `409 DEPLOYMENT_MISMATCH`, and the page then reloads (when `skew.reload` is on, the default) to pick up the
 * new build. Without a configured id nothing is sent and nothing reloads.
 *
 * @packageDocumentation
 */

/** The header that carries the deployment id. Must match `DEPLOYMENT_HEADER` on the server. @internal */
export const DEPLOYMENT_HEADER_NAME = "x-dusk-deployment";

interface Deployment {
  readonly id: string;
  readonly onMismatch: (() => void) | undefined;
}

/**
 * The deployment this page was built for, set by `hydrateDusk`. Module state, as the call queue of the stubs
 * is: one page, one deployment.
 */
let current: Deployment | undefined;

/**
 * Sets the deployment id of this page, and what to do on a mismatch. Called by `hydrateDusk`.
 *
 * @param id The deployment id, or `undefined` to send nothing.
 * @param onMismatch Called once per refused call; `undefined` for no reaction.
 * @internal
 */
export function configureDeployment(
  id: string | undefined,
  onMismatch: (() => void) | undefined,
): void {
  current = id === undefined ? undefined : { id, onMismatch };
}

/**
 * Adds the deployment header to a call, when a deployment id is configured.
 *
 * @param headers The call's headers.
 * @internal
 */
export function applyDeploymentHeader(headers: Headers): void {
  if (current !== undefined) headers.set(DEPLOYMENT_HEADER_NAME, current.id);
}

/**
 * A call was refused for another deployment: the page reacts (by default it reloads).
 *
 * @internal
 */
export function noteDeploymentMismatch(): void {
  current?.onMismatch?.();
}

/**
 * The default reaction: reload the page, so the new build is loaded.
 *
 * @internal
 */
export function reloadPage(): void {
  globalThis.location?.reload();
}
