import { createComponent, hydrate } from "@shadow-js/web";
import {
  createComponent as createServerComponent,
  createServerHead,
  renderToString,
} from "@shadow-js/web/server";

/**
 * Server render, then hydrate the same component into the markup. The serverside elements must survive the
 * hydration (the browser claims them; it does not build a second copy).
 */
export interface Hydrated {
  readonly html: string;
  readonly host: HTMLElement;
  readonly serverElements: Element[];
  readonly preload: string;
  dispose(): void;
}

export function ssrAndHydrate(
  ssr: (props: Record<string, unknown>) => unknown,
  dom: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown> = {},
): Hydrated {
  const head = createServerHead();
  const html = renderToString(() => createServerComponent(ssr as never, props), { head });
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const serverElements = [...host.querySelectorAll("*")];
  const stop = hydrate(() => createComponent(dom as never, props), host);
  return {
    html,
    host,
    serverElements,
    preload: head.html(),
    dispose() {
      if (typeof stop === "function") stop();
      host.remove();
    },
  };
}
