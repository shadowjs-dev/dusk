/**
 * Deployment skew. A browser keeps the app it loaded; after a deploy its server functions may have changed.
 * The client sends the deployment id of its build in `x-dusk-deployment` on every server function call; a
 * call from another deployment is refused with `409 DEPLOYMENT_MISMATCH`, and the client reloads the page.
 * A call without the header (a client from before this check, or a script) is not refused.
 *
 * @packageDocumentation
 */

/** The request header that carries the client's deployment id. @since 1.0.0 */
export const DEPLOYMENT_HEADER = "x-dusk-deployment";

/** The error code of a refused call. @since 1.0.0 */
export const DEPLOYMENT_MISMATCH = "DEPLOYMENT_MISMATCH";

/**
 * Whether a call may run: true when no deployment id is configured, when the call has no header, or when the
 * header equals the configured id.
 *
 * @param request The call.
 * @param expected The deployment id of this server.
 * @returns Whether to run the call.
 * @since 1.0.0
 */
export function checkDeploymentHeader(request: Request, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const sent = request.headers.get(DEPLOYMENT_HEADER);
  return sent === null || sent === expected;
}

/**
 * The envelope of a refused call, in the server function wire format.
 *
 * @param requestId The request id.
 * @returns The envelope.
 * @since 1.0.0
 */
export function deploymentMismatchEnvelope(requestId: string): {
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly code: string;
    readonly message: string;
    readonly status: number;
    readonly requestId: string;
  };
} {
  return {
    ok: false,
    error: {
      name: "DeploymentMismatch",
      code: DEPLOYMENT_MISMATCH,
      message: "The application was redeployed. Reload the page.",
      status: 409,
      requestId,
    },
  };
}
