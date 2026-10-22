/**
 * End-to-end type flows of Dusk: a schema goes in, the callable, the handler context, the stream
 * item and the failure value come out with the types the author wrote. Each `@ts-expect-error`
 * marks a call that must not compile; if one stops failing, the type it guards has widened.
 *
 * Compile with `npm run typecheck:types` in packages/dusk.
 */

import { type ClientServerFn, serverFnStub } from "@shadow-js/dusk/client";
import { serverStreamStub } from "@shadow-js/dusk/client/stream";
import {
  type ActionFailure,
  type ApiContext,
  apiHandler,
  apiRoute,
  fail,
  isFailure,
  type RequestEvent,
  redirect,
  type ServerFn,
  type ServerFnCallOptions,
  type ServerFnContext,
  type ServerFnMiddleware,
  serverFn,
} from "@shadow-js/dusk/server";
import { type Equal, type Expect, testSchema } from "./support";

// ---------------------------------------------------------------------------------------------
// serverFn: schema input and output reach the callable signature.
// ---------------------------------------------------------------------------------------------

interface TodoInput {
  readonly title: string;
}

const todoSchema = testSchema<TodoInput, { readonly title: string }>();

export const addTodo = serverFn({ input: todoSchema }, (input, event) => {
  type HandlerInput = Expect<Equal<typeof input, { readonly title: string }>>;
  type HandlerEvent = Expect<Equal<typeof event, RequestEvent>>;
  return { id: input.title.length, owner: event.url.pathname };
});

// The callable takes the schema INPUT type, and resolves to the handler's awaited return type.
type AddTodoResult = Expect<
  Equal<Awaited<ReturnType<typeof addTodo>>, { id: number; owner: string }>
>;
type AddTodoArgs = Expect<
  Equal<Parameters<typeof addTodo>, [input: TodoInput, options?: ServerFnCallOptions]>
>;

export async function callAddTodo(): Promise<void> {
  const ok = await addTodo({ title: "write tests" });
  const okValue: number = ok.id;
  void okValue;

  // @ts-expect-error the title must be a string
  await addTodo({ title: 1 });
  // @ts-expect-error the input is required because the schema input type excludes undefined
  await addTodo();
  // @ts-expect-error a missing property is not the schema input
  await addTodo({});
  // @ts-expect-error an unknown option is not a call option
  await addTodo({ title: "x" }, { bogus: true });
  await addTodo({ title: "x" }, { signal: new AbortController().signal });
}

// `with()` is the same call with options, and takes the input without the options argument.
export const addTodoWith = addTodo.with({ headers: { "x-test": "1" } });
type WithResult = Expect<
  Equal<Awaited<ReturnType<typeof addTodoWith>>, { id: number; owner: string }>
>;

// A schema whose input allows undefined makes the input argument optional.
const optionalSchema = testSchema<
  { readonly page?: number } | undefined,
  { readonly page: number }
>();
export const listTodos = serverFn({ input: optionalSchema }, (input) => {
  type Output = Expect<Equal<typeof input, { readonly page: number }>>;
  return [input.page];
});
export async function callListTodos(): Promise<void> {
  await listTodos();
  await listTodos({ page: 2 });
  // @ts-expect-error the page must be a number
  await listTodos({ page: "2" });
}

// ---------------------------------------------------------------------------------------------
// serverFn without a schema: the input is untrusted `unknown`, so no argument is required.
// ---------------------------------------------------------------------------------------------

export const ping = serverFn({}, () => "pong");
type PingResult = Expect<Equal<Awaited<ReturnType<typeof ping>>, string>>;
export async function callPing(): Promise<void> {
  const pong: string = await ping();
  void pong;
  await ping(undefined, { signal: new AbortController().signal });
}

// A handler that returns a promise resolves to the awaited value, not to the promise.
export const delayed = serverFn({}, async () => 42);
type DelayedResult = Expect<Equal<Awaited<ReturnType<typeof delayed>>, number>>;

// ---------------------------------------------------------------------------------------------
// GET vs POST: the method is an option; only the two names are accepted.
// ---------------------------------------------------------------------------------------------

export const readCount = serverFn(
  { method: "GET", input: testSchema<{ id: string }, { id: string }>() },
  (input) => input.id,
);
export const writeCount = serverFn(
  { method: "POST", input: testSchema<{ id: string }, { id: string }>() },
  (input) => input.id,
);
// @ts-expect-error the method is GET or POST only
export const badMethod = serverFn({ method: "PUT" }, () => 1);
// @ts-expect-error a stub method is GET or POST only
serverFnStub<unknown, unknown>("id", { method: "PATCH", form: false, base: "" });
// The definition exposes the union of the two names, not the name of one function (gap, see bugsFound).
type MethodUnion = Expect<Equal<ServerFn<unknown, unknown, unknown>["method"], "GET" | "POST">>;

// ---------------------------------------------------------------------------------------------
// Streaming: `stream: true` yields AsyncIterable of the item type.
// ---------------------------------------------------------------------------------------------

export const ticks = serverFn(
  { stream: true, input: testSchema<{ count: number }, { count: number }>() },
  async function* (input) {
    for (let index = 0; index < input.count; index += 1) {
      yield index;
    }
  },
);
type TicksResult = Expect<Equal<ReturnType<typeof ticks>, Promise<AsyncIterable<number>>>>;

export async function consumeTicks(): Promise<void> {
  for await (const tick of await ticks({ count: 3 })) {
    type Item = Expect<Equal<typeof tick, number>>;
    const next: number = tick;
    void next;
  }
  // @ts-expect-error the stream input is still the schema input
  await ticks({ count: "3" });
}

// A stream owns one request: it cannot be a form, a batch, or cached.
// @ts-expect-error a stream cannot also be a form
serverFn({ stream: true, form: true }, async function* () {
  yield 1;
});
// @ts-expect-error a stream cannot be batched
serverFn({ stream: true, batch: true }, async function* () {
  yield 1;
});

// ---------------------------------------------------------------------------------------------
// API routes: apiHandler gives the context types of body and query; apiRoute keeps the methods.
// ---------------------------------------------------------------------------------------------

export const createTodo = apiHandler(
  {
    body: testSchema<{ title: string }, { title: string }>(),
    query: testSchema<{ page?: string }, { page: number }>(),
  },
  (context) => {
    type Body = Expect<Equal<typeof context.body, { title: string }>>;
    type Query = Expect<Equal<typeof context.query, { page: number }>>;
    type Event = Expect<Equal<typeof context.event, RequestEvent>>;
    return { title: context.body.title, page: context.query.page };
  },
);

export const listItems = apiHandler({}, (context) => {
  type NoBody = Expect<Equal<typeof context.body, undefined>>;
  type NoQuery = Expect<Equal<typeof context.query, undefined>>;
  return [context.event.url.pathname];
});

// The context type is a named export, and it is generic over the body and query types.
type ContextOfCreate = ApiContext<{ title: string }, { page: number }>;
type ContextShape = Expect<Equal<ContextOfCreate["body"], { title: string }>>;

export const api = apiRoute({ POST: createTodo, GET: listItems, csrf: false });
type ApiKeys = Expect<Equal<keyof typeof api, "POST" | "GET" | "csrf">>;

// @ts-expect-error a method export must be an API handler, not a value
apiRoute({ GET: 1 });

// ---------------------------------------------------------------------------------------------
// Middleware: a server function middleware receives the event and the input (untyped, see gap).
// ---------------------------------------------------------------------------------------------

export const audit: ServerFnMiddleware = (context, next) => {
  type Context = Expect<Equal<typeof context, ServerFnContext>>;
  type Event = Expect<Equal<typeof context.event, RequestEvent>>;
  // The input is `unknown` in the middleware context, not the schema input (gap, see bugsFound).
  type Input = Expect<Equal<typeof context.input, unknown>>;
  return next();
};

export const guarded = serverFn({ middleware: [audit] }, () => "ok");

// ---------------------------------------------------------------------------------------------
// Failures and redirects: what exists in the public surface (no loader or action types exist).
// ---------------------------------------------------------------------------------------------

export const submit = serverFn(
  { input: testSchema<{ title: string }, { title: string }>() },
  async ({ title }) => {
    if (title.length === 0) {
      return fail(400, { field: "title" as const });
    }
    return { saved: true as const };
  },
);
type SubmitResult = Expect<
  Equal<Awaited<ReturnType<typeof submit>>, ActionFailure<{ field: "title" }> | { saved: true }>
>;

export async function readSubmit(): Promise<void> {
  const result = await submit({ title: "x" });
  if (isFailure(result)) {
    type Status = Expect<Equal<typeof result.status, number>>;
    const status: number = result.status;
    void status;
  }
}

// `fail()` without data carries `undefined`.
type BareFailure = Expect<Equal<ReturnType<typeof fail<undefined>>, ActionFailure<undefined>>>;
// @ts-expect-error the status is a number and the data is the second argument
fail("400", { field: "title" });

// A redirect is a signal value: it is thrown or returned, and its status is a plain number.
export const movedHandler = serverFn({}, () => {
  return redirect("/moved", { status: 303 });
});
// @ts-expect-error a redirect target is a string
redirect(404);

// ---------------------------------------------------------------------------------------------
// Browser stubs: the stub has the call signature of the server function it stands for.
// ---------------------------------------------------------------------------------------------

const addTodoStub = serverFnStub<TodoInput, { id: number; owner: string }>("addTodo", {
  method: "POST",
  form: false,
  base: "",
});
type StubResult = Expect<
  Equal<ReturnType<typeof addTodoStub>, Promise<{ id: number; owner: string }>>
>;
type StubIsClient = Expect<
  Equal<typeof addTodoStub, ClientServerFn<TodoInput, { id: number; owner: string }>>
>;

// A server function's callable is assignable to the client stub type with the same input and output.
export const clientView: ClientServerFn<TodoInput, { id: number; owner: string }> = addTodo;

export async function callStub(): Promise<void> {
  await addTodoStub({ title: "x" }, { signal: new AbortController().signal });
  // @ts-expect-error the stub input is the schema input type
  await addTodoStub({ title: 1 });
  // @ts-expect-error the stub input is required
  await addTodoStub();
}

const tickStub = serverStreamStub<{ count: number }, number>("ticks", {
  method: "GET",
  form: false,
  base: "",
});
type TickStubResult = Expect<Equal<ReturnType<typeof tickStub>, Promise<AsyncIterable<number>>>>;
