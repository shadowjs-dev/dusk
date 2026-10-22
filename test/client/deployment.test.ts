import { describe, expect, it, vi } from "vitest";
import {
  applyDeploymentHeader,
  configureDeployment,
  DEPLOYMENT_HEADER_NAME,
  noteDeploymentMismatch,
} from "../../src/client/deployment";

describe("deployment skew on the client", () => {
  it("[DEP-4] with a configured id every call carries `x-dusk-deployment`; without one nothing is sent", () => {
    const headers = new Headers();
    configureDeployment("rel-9", () => undefined);
    applyDeploymentHeader(headers);
    expect(headers.get(DEPLOYMENT_HEADER_NAME)).toBe("rel-9");
    const none = new Headers();
    configureDeployment(undefined, undefined);
    applyDeploymentHeader(none);
    expect(none.has(DEPLOYMENT_HEADER_NAME)).toBe(false);
  });

  it("[DEP-5] a refused call (409) runs the page's reaction once per refusal; with no reaction nothing happens", () => {
    const onMismatch = vi.fn();
    configureDeployment("rel-9", onMismatch);
    noteDeploymentMismatch();
    noteDeploymentMismatch();
    expect(onMismatch).toHaveBeenCalledTimes(2);
    configureDeployment("rel-9", undefined);
    expect(() => noteDeploymentMismatch()).not.toThrow();
    configureDeployment(undefined, undefined);
  });
});
