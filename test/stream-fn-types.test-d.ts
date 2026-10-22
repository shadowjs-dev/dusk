import { expectTypeOf } from "vitest";
import { useStream } from "../src/client/stream";
import { serverFn } from "../src/server/server-fn";
import type { StandardSchemaV1 } from "../src/server/standard-schema";

const ticks = serverFn({ stream: true }, async function* () {
  yield { id: 1, label: "tick" };
});
expectTypeOf(ticks()).toEqualTypeOf<Promise<AsyncIterable<{ id: number; label: string }>>>();
const result = useStream((signal) => ticks(undefined, { signal }));
expectTypeOf(result.value()).toEqualTypeOf<{ id: number; label: string } | undefined>();
const schema: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: String(value).length }),
  },
};
const lengths = serverFn({ stream: true, input: schema }, async function* (length) {
  expectTypeOf(length).toEqualTypeOf<number>();
  yield { length };
});
expectTypeOf(lengths("hello")).toEqualTypeOf<Promise<AsyncIterable<{ length: number }>>>();
// @ts-expect-error [RPC-STREAM-TYPE-04] the schema's required input is retained.
lengths();
// @ts-expect-error [RPC-STREAM-TYPE-05] the schema's input is distinct from its parsed output.
lengths(5);
// @ts-expect-error [RPC-STREAM-TYPE-01] streaming handlers must return an AsyncIterable.
serverFn({ stream: true }, () => "ordinary output");
// @ts-expect-error [RPC-STREAM-TYPE-02] form posts cannot consume typed streams.
serverFn({ stream: true, form: true }, async function* () {
  yield 1;
});
// @ts-expect-error [RPC-STREAM-TYPE-03] batches cannot hold indefinite streaming answers.
serverFn({ stream: true, batch: true }, async function* () {
  yield 1;
});
