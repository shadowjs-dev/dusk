/**
 * `@shadow-js/dusk/client`: the browser side of Dusk. `hydrateDusk()` boots the app on
 * top of the server's markup; `serverFnStub()` is what the build puts in place of a server
 * function. Safe to import from client code; it imports nothing server-only.
 * @packageDocumentation
 */

export { HttpError, isHttpError } from "../internal/http-error";
export { isNotFound, isRedirect, notFound, redirect } from "../internal/redirect";
export { type ActionFailure, fail, isFailure } from "../shared/action";
export { type LoadScriptOptions, loadScript } from "../shared/script";
export { Await, type AwaitProps } from "./await";
export { ServerFnError, ServerFnProtocolError } from "./errors";
export { type ClientServerFn, type ServerFnCallOptions, serverFnStub } from "./fn";
export {
  Form,
  type FormProps,
  type FormStatus,
  type FormTarget,
  useFormStatus,
} from "./form";
export {
  type DuskAppComponent,
  type DuskClient,
  type HydrateDuskOptions,
  hydrateDusk,
} from "./hydrate";
export {
  type HydrateIslandsOptions,
  hydrateIslands,
  type IslandComponent,
  type IslandModule,
  type IslandRegistry,
  type IslandsHandle,
} from "./islands";
export {
  createSseClient,
  createWebSocketClient,
  type ReconnectOptions,
  type SseClient,
  type SseClientOptions,
  type SseEvent,
  type StreamHandle,
  type StreamStatus,
  type UseSseOptions,
  type UseWebSocketOptions,
  useSSE,
  useWebSocket,
  type WebSocketClient,
  type WebSocketClientOptions,
  type WebSocketHandle,
} from "./streams";
export {
  type Fetcher,
  type FetcherState,
  type Revalidator,
  type Submission,
  type SubmissionStatus,
  type SubmissionView,
  type SubmitOptions,
  useFetcher,
  useFlash,
  useRevalidator,
  useSubmission,
  useSubmissions,
  useSubmit,
} from "./submissions";
