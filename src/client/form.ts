import { createContext, isServer, onCleanup, useContext, useSignal } from "@shadow-js/core";
import { createComponent, Dynamic } from "@shadow-js/web";
import type { WireIssue } from "../shared/action";
import { ServerFnError } from "./errors";
import {
  createSubmissionStore,
  currentStore,
  type Submission,
  type SubmissionStore,
} from "./submissions";

/**
 * `<Form>` and its progressive enhancement. Without JavaScript the form is an ordinary HTML form: a GET
 * goes to its URL, a POST goes to the server function's endpoint, and the server answers as it does for
 * any classic form post (the result comes back on the page; see the mutation contract). With JavaScript
 * the submit is intercepted and goes through the same server function over RPC: no page load, the
 * outcome lands in the submission store, the form is busy until it settles, and field problems are marked
 * and focused.
 */

/** A server function as a form target: its id and endpoint. @since 1.0.0 */
export interface FormTarget {
  /** The stable id (the key of its submissions). */
  readonly id: string;
  /** The endpoint, for example `/_dusk/fn/<id>`: where a no-JS post goes. */
  readonly url: string;
}

/**
 * Props of {@link Form}. Other attributes pass to the `<form>` element.
 * @since 1.0.0
 */
export interface FormProps {
  /** A URL (a GET to it navigates; a POST goes to it as a plain request) or a server function (a POST to its endpoint). */
  readonly action?: string | FormTarget;
  /** `"get"` or `"post"`. Default: `"post"` for a server function, `"get"` for a URL. */
  readonly method?: "get" | "post";
  /** Replace the history entry of a GET navigation. Default `false`. */
  readonly replace?: boolean;
  /** Do not intercept the submit: the browser submits the form itself. Default `false`. */
  readonly reloadDocument?: boolean;
  /** `false` leaves a GET to the browser (no client navigation). Default `true`. */
  readonly navigate?: boolean;
  /** After a GET navigation: `"reset"` (the router scrolls to the top, the default) or `"keep"` the scroll position. */
  readonly scroll?: "reset" | "keep";
  /** After a successful server function call, refresh the loader data of the page. Default `true`. */
  readonly revalidate?: boolean;
  /** Reset the fields after a success (not after a failure). Default `false`. */
  readonly resetOnSuccess?: boolean;
  /** Move focus to the first field with a problem (or to `[data-dusk-form-errors]`) after a failure. Default `true`. */
  readonly focusOnError?: boolean;
  /** Called with the result of a successful call (a `fail()` result included), before the form is reset. */
  readonly onResult?: (result: unknown, form: HTMLFormElement) => void;
  /** Called with the error of a failed call. */
  readonly onError?: (error: unknown, form: HTMLFormElement) => void;
  /** Called before the submit is intercepted; `preventDefault()` leaves the submit to the browser. */
  readonly onSubmit?: (event: Event) => void;
  readonly children?: unknown;
  readonly [attribute: string]: unknown;
}

/**
 * What a form's descendants read with {@link useFormStatus}.
 * @since 1.0.0
 */
export interface FormStatus {
  /** True while the form's POST runs. */
  readonly pending: boolean;
  /** The method of the form. */
  readonly method: "get" | "post";
  /** The action the form submits to (the URL, or the endpoint of the function). */
  readonly action: string;
}

/** The status of the nearest `<Form>`. @internal */
const FormStatusContext = createContext<FormStatus | null>(null);

/**
 * The status of the `<Form>` a component is inside: pending state and target. Outside a form it reports
 * not pending.
 *
 * @returns The status of the nearest form.
 * @example
 * function SubmitButton() {
 *   const status = useFormStatus();
 *   return <button type="submit" disabled={status.pending}>{status.pending ? "Saving" : "Save"}</button>;
 * }
 * @since 1.0.0
 */
export function useFormStatus(): FormStatus {
  return useContext(FormStatusContext) ?? { pending: false, method: "get", action: "" };
}

/** Options of {@link enhanceForm}. @internal */
export interface EnhanceOptions {
  /** The server function a POST goes to. */
  readonly fn?: { readonly id: string };
  /** The URL of a GET, or of a POST without a server function. */
  readonly href?: string;
  /** `"get"` or `"post"`. Default: `"post"` with a function, `"get"` otherwise. */
  readonly method?: "get" | "post";
  /** The store the submissions go to. */
  readonly store?: SubmissionStore;
  /** Navigates a GET. Without it a GET is left to the browser. */
  readonly navigate?: (to: string, options: { readonly replace: boolean }) => unknown;
  readonly replace?: boolean;
  readonly reloadDocument?: boolean;
  readonly keepScroll?: boolean;
  readonly revalidate?: boolean;
  readonly resetOnSuccess?: boolean;
  readonly focusOnError?: boolean;
  readonly onResult?: (result: unknown, form: HTMLFormElement) => void;
  readonly onError?: (error: unknown, form: HTMLFormElement) => void;
  readonly onSubmit?: (event: Event) => void;
  readonly onPending?: (pending: boolean) => void;
}

/** True for a plain object. @internal */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/** The problems of a list, when every entry has a message and a path. @internal */
function issueList(value: unknown): WireIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WireIssue[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const message = item["message"];
    const path = item["path"];
    if (typeof message === "string" && Array.isArray(path)) {
      out.push({
        message,
        path: path.map((segment: unknown) =>
          typeof segment === "number" ? segment : String(segment),
        ),
      });
    }
  }
  return out;
}

/**
 * The field problems a failure or an error carries: `issues` (a failed result, a flash error), or
 * `data.issues` (a thrown `HttpError` with issues, a `fail()` result). @internal
 */
export function issuesOf(source: unknown): WireIssue[] | undefined {
  if (!isRecord(source)) return undefined;
  const direct = issueList(source["issues"]);
  if (direct !== undefined) return direct;
  const data = source["data"];
  return isRecord(data) ? issueList(data["issues"]) : undefined;
}

/** The field name of a path: `["lines", 0, "sku"]` is `lines[0].sku`. @internal */
function nameOf(path: readonly (string | number)[]): string {
  return path
    .map((segment, index) => {
      const text = String(segment);
      if (typeof segment === "number") return `[${text}]`;
      return index === 0 ? text : `.${text}`;
    })
    .join("");
}

/** Clears the problem marks of the form. @internal */
function clearMarks(form: HTMLFormElement): void {
  for (const element of Array.from(form.querySelectorAll('[aria-invalid="true"]'))) {
    element.removeAttribute("aria-invalid");
  }
}

/**
 * Marks the fields that have a problem (`aria-invalid="true"`) and moves focus to the first of them, or
 * to the form's error summary (`[data-dusk-form-errors]`) when it has one. @internal
 */
function markIssues(form: HTMLFormElement, issues: readonly WireIssue[], focus: boolean): void {
  clearMarks(form);
  let first: HTMLElement | undefined;
  for (const issue of issues) {
    const name = nameOf(issue.path);
    for (const element of Array.from(form.elements)) {
      if (element instanceof HTMLElement && element.getAttribute("name") === name) {
        element.setAttribute("aria-invalid", "true");
        first ??= element;
      }
    }
  }
  if (!focus) return;
  const summary = form.querySelector<HTMLElement>("[data-dusk-form-errors]");
  // A browser ignores focus() on a container without a tabindex: the summary is made focusable (not tabbable) first.
  if (summary !== null && summary.tabIndex < 0 && !summary.hasAttribute("tabindex")) {
    summary.setAttribute("tabindex", "-1");
  }
  const target = summary ?? first;
  target?.focus();
}

/** A POST to a plain URL: the answer's JSON or text, or a `ServerFnError` for a status that is not OK. @internal */
async function postUrl(href: string, body: FormData): Promise<unknown> {
  const response = await globalThis.fetch(href, {
    method: "POST",
    body,
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ServerFnError(response.statusText || "Request failed", response.status, undefined);
  }
  const type = response.headers.get("content-type") ?? "";
  return type.includes("json") ? (JSON.parse(text) as unknown) : text;
}

/** The query text of a form's text fields, for a GET. @internal */
function queryOf(data: FormData): string {
  const params = new URLSearchParams();
  for (const [name, value] of data.entries()) {
    if (typeof value === "string") params.append(name, value);
  }
  return params.toString();
}

/**
 * Intercepts the submits of a form element (progressive enhancement). A GET becomes a navigation through
 * `navigate`; a POST becomes a submission on `store`. The form is busy (`aria-busy`) while its POST runs, and a
 * second submit meanwhile is ignored. After the outcome: a success calls `onResult` (and resets the fields when
 * asked); an error calls `onError`; field problems mark their fields. A submit whose event is already
 * `preventDefault()`ed is not handled.
 *
 * @param form The form element.
 * @param options What the submit goes to, and the behavior after it.
 * @returns A function that removes the listener.
 * @internal
 */
export function enhanceForm(form: HTMLFormElement, options: EnhanceOptions): () => void {
  if (options.reloadDocument === true) return () => undefined;
  const store = options.store ?? createSubmissionStore();
  const method = options.method ?? (options.fn === undefined ? "get" : "post");
  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    if (value) form.setAttribute("aria-busy", "true");
    else form.removeAttribute("aria-busy");
    options.onPending?.(value);
  };
  const after = (sub: Submission): void => {
    const focus = options.focusOnError !== false;
    if (sub.status() === "success") {
      const result = sub.result();
      const failed = sub.failed();
      if (failed) {
        const issues = issuesOf(result);
        if (issues !== undefined) markIssues(form, issues, focus);
      } else {
        clearMarks(form);
        if (options.resetOnSuccess === true) form.reset();
      }
      options.onResult?.(result, form);
      return;
    }
    if (sub.status() === "error") {
      const error = sub.error();
      const issues = issuesOf(error);
      if (issues !== undefined) markIssues(form, issues, focus);
      options.onError?.(error, form);
    }
  };
  const onSubmit = (event: Event): void => {
    if (event.defaultPrevented) return;
    options.onSubmit?.(event);
    if (event.defaultPrevented) return;
    // A plain browser submit includes the name and value of the button that was pressed (`intent=delete`); the form's
    // own elements do not list it, so it is passed along (`undefined` for an event made by hand).
    const data = new FormData(form, (event as SubmitEvent).submitter);
    if (method === "get") {
      if (options.navigate === undefined || options.href === undefined) return;
      event.preventDefault();
      const query = queryOf(data);
      const to =
        query === ""
          ? options.href
          : `${options.href}${options.href.includes("?") ? "&" : "?"}${query}`;
      const scroll =
        options.keepScroll === true ? { x: window.scrollX, y: window.scrollY } : undefined;
      const outcome = options.navigate(to, { replace: options.replace === true });
      if (scroll !== undefined) {
        void Promise.resolve(outcome).then(() => window.scrollTo(scroll.x, scroll.y));
      }
      return;
    }
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const revalidate = options.revalidate === undefined ? {} : { revalidate: options.revalidate };
    const sub =
      options.fn !== undefined
        ? store.submitTo(options.fn as { readonly id: string }, data, revalidate)
        : store.submit(
            options.href ?? "",
            (body: FormData) => postUrl(options.href ?? "", body),
            data,
            { revalidate: false },
          );
    void sub.done.then(() => {
      setBusy(false);
      after(sub);
    });
  };
  form.addEventListener("submit", onSubmit);
  return () => form.removeEventListener("submit", onSubmit);
}

/**
 * A form. Without JavaScript it is an HTML form: a GET goes to the URL, a POST goes to the server
 * function's endpoint (`/_dusk/fn/<id>`) and the page the browser is sent back to shows the outcome. With
 * JavaScript the submit goes to the same function through RPC: the page does not reload, the outcome is in
 * `useSubmission`, `useFormStatus` reports pending, a second submit while pending is ignored, and field
 * problems are marked and focused. A URL action with a GET navigates the router (keep the query in the
 * URL, `replace` replaces the history entry).
 *
 * Works with `@shadow-js/forms`: `onResult` gets the failure, and `applyServerErrors(form, result.data)`
 * shows the problems on that form's fields.
 *
 * @param props See {@link FormProps}.
 * @returns A `<form>` element.
 * @example
 * <Form action={saveNote} resetOnSuccess>
 *   <input name="title" required />
 *   <SubmitButton />
 * </Form>
 * @since 1.0.0
 */
export function Form(props: FormProps): unknown {
  const {
    action,
    method: requested,
    replace,
    reloadDocument,
    navigate,
    scroll,
    revalidate,
    resetOnSuccess,
    focusOnError,
    onResult,
    onError,
    onSubmit,
    enctype,
    children,
    ...attributes
  } = props;
  // A server function stub is a function (with `id` and `url`), so any non-string target is one.
  const fn = typeof action === "string" || action === undefined ? undefined : action;
  const href = typeof action === "string" ? action : fn?.url;
  const method = requested ?? (fn === undefined ? "get" : "post");
  const store = currentStore();
  const [pending, setPending] = useSignal(false);
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  const ref = (element: Element): void => {
    if (isServer || !(element instanceof HTMLFormElement)) return;
    const navigateTo = store.navigateTo;
    stop = enhanceForm(element, {
      ...(fn === undefined ? {} : { fn }),
      ...(href === undefined ? {} : { href }),
      method,
      store,
      ...(navigate === false || navigateTo === undefined
        ? {}
        : {
            navigate: (to: string, options: { readonly replace: boolean }) =>
              navigateTo(to, options.replace),
          }),
      replace: replace === true,
      reloadDocument: reloadDocument === true,
      keepScroll: scroll === "keep",
      ...(revalidate === undefined ? {} : { revalidate }),
      resetOnSuccess: resetOnSuccess === true,
      focusOnError: focusOnError !== false,
      ...(onResult === undefined ? {} : { onResult }),
      ...(onError === undefined ? {} : { onError }),
      ...(onSubmit === undefined ? {} : { onSubmit }),
      onPending: setPending,
    });
  };
  const status: FormStatus = {
    get pending() {
      return pending();
    },
    method,
    action: href ?? "",
  };
  return Dynamic({
    component: "form",
    ...attributes,
    method: method === "post" ? "post" : "get",
    ...(href === undefined ? {} : { action: href }),
    ...(fn === undefined ? {} : { enctype: enctype ?? "multipart/form-data" }),
    ...(enctype === undefined || fn !== undefined ? {} : { enctype }),
    ref,
    children: createComponent(FormStatusContext.Provider, {
      value: status,
      get children() {
        return children;
      },
    }),
  });
}
