import { expect, it } from "vitest";
import { rpc } from "../src/features/rpc";
import { serverFn } from "../src/server/server-fn";

it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])(
  "[RPC-STREAM-OPTIONS-01] invalid deadlines fail before a handler exists (%s)",
  (maxDurationMs) => {
    expect(() => rpc({ streams: { maxDurationMs } })).toThrow(RangeError);
  },
);
it.each([0, -1, NaN, Infinity, 0.5, 10_001])(
  "[RPC-STREAM-OPTIONS-02] invalid item bounds fail before a handler exists (%s)",
  (maxItems) => {
    expect(() => rpc({ streams: { maxItems } })).toThrow(RangeError);
  },
);
it.each([{ form: true }, { batch: true }, { singleFlight: true }, { cacheControl: "no-store" }])(
  "[RPC-STREAM-OPTIONS-03] JavaScript callers cannot combine incompatible stream options (%j)",
  (extra) => {
    expect(() =>
      Reflect.apply(serverFn, undefined, [
        { stream: true, ...extra },
        async function* () {
          yield 1;
        },
      ]),
    ).toThrow(TypeError);
  },
);
it.each([null, [], "yes", true])(
  "[RPC-STREAM-OPTIONS-04] malformed stream configuration cannot enable delivery (%j)",
  (streams) => {
    expect(() => Reflect.apply(rpc, undefined, [{ streams }])).toThrow(TypeError);
  },
);
