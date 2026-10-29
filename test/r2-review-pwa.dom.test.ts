import { createRoot } from "@shadow-js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker, useServiceWorkerUpdate } from "../src/features/pwa";

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  throwOnPost = false;
  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error("worker is gone");
    this.messages.push(message);
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
}

class FakeContainer extends EventTarget {
  readonly registration = new FakeRegistration();
  async register(): Promise<FakeRegistration> {
    return this.registration;
  }
}

let container: FakeContainer;
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  container = new FakeContainer();
  vi.stubGlobal("navigator", { serviceWorker: container });
  vi.stubGlobal("location", { reload });
  reload.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function register(): Promise<void> {
  await registerServiceWorker({ dev: true });
}

function waitFor(worker: FakeWorker): void {
  container.registration.waiting = worker;
  container.registration.dispatchEvent(new Event("updatefound"));
  const installing = new FakeWorker();
  container.registration.installing = installing;
  container.registration.dispatchEvent(new Event("updatefound"));
  installing.dispatchEvent(new Event("statechange"));
}

describe("pwa: update state", () => {
  it("[DUSK-R2-1] update() can run again when controllerchange never fires (bounded timeout)", async () => {
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await register();
    const worker = new FakeWorker();
    waitFor(worker);
    createRoot((dispose) => {
      const { waiting, update } = useServiceWorkerUpdate();
      expect(waiting()).toBe(true);
      update();
      update();
      expect(worker.messages).toHaveLength(1);
      vi.advanceTimersByTime(10_000);
      update();
      expect(worker.messages).toHaveLength(2);
      dispose();
    });
  });

  it("[DUSK-R2-1] a controllerchange reloads once and frees the lock", async () => {
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await register();
    const worker = new FakeWorker();
    waitFor(worker);
    createRoot((dispose) => {
      const { update } = useServiceWorkerUpdate();
      update();
      container.dispatchEvent(new Event("controllerchange"));
      expect(reload).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20_000);
      update();
      expect(worker.messages).toHaveLength(2);
      dispose();
    });
  });

  it("[DUSK-R2-1] a postMessage that throws releases the lock and rethrows", async () => {
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await register();
    const worker = new FakeWorker();
    waitFor(worker);
    createRoot((dispose) => {
      const { update } = useServiceWorkerUpdate();
      worker.throwOnPost = true;
      expect(() => update()).toThrow("worker is gone");
      worker.throwOnPost = false;
      update();
      expect(worker.messages).toHaveLength(1);
      dispose();
    });
  });

  it("[DUSK-R2-1] the state belongs to the page's container: a new container starts clean", async () => {
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
    await register();
    waitFor(new FakeWorker());
    createRoot((dispose) => {
      expect(useServiceWorkerUpdate().waiting()).toBe(true);
      dispose();
    });
    vi.stubGlobal("navigator", { serviceWorker: new FakeContainer() });
    createRoot((dispose) => {
      expect(useServiceWorkerUpdate().waiting()).toBe(false);
      dispose();
    });
  });
});
