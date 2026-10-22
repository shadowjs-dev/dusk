/**
 * `@shadow-js/dusk/testing`: call a handler without a network. A client that keeps cookies, adds
 * the headers a same-origin browser adds, follows redirects on request and calls server functions
 * with the real wire format; plus an event factory for unit tests.
 * @packageDocumentation
 */

export {
  createTestClient,
  type ServerFnCallOptions,
  type ServerFnResult,
  type TestClient,
  type TestClientOptions,
  type TestRequestInit,
} from "./client";
export { createTestCookieJar, type StoredCookie, type TestCookieJar } from "./cookie-jar";
export { createTestEvent, type TestEventOptions } from "./event";
export { createFakeKeyValue, type FakeKeyValue } from "./key-value";
export {
  KV_CONFORMANCE,
  type KvConformanceCase,
  type KvHarness,
} from "./kv-conformance";
