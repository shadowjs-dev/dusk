/**
 * Thrown values that a naive error path mishandles: cycles in arrays, objects and cause chains; symbols; frozen
 * objects; primitives; a null prototype; a message getter and a toString that throw. Each test builds the list
 * fresh, so no test shares a value with another.
 */
export function hostileThrown(): Array<[string, unknown]> {
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  const cyclicObject: { self?: unknown } = {};
  cyclicObject.self = cyclicObject;
  const selfCaused = new Error("self caused");
  selfCaused.cause = selfCaused;
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  const frozenError = Object.freeze(new Error("frozen"));
  const frozenObject = Object.freeze({ message: "frozen object", digest: "frozen-1" });
  const throwingMessage = Object.defineProperty(new Error("placeholder"), "message", {
    get: () => {
      throw new TypeError("message getter threw");
    },
  });
  const throwingCode = Object.defineProperty(new Error("code placeholder"), "code", {
    get: () => {
      throw new TypeError("code getter threw");
    },
  });
  const throwingToString = {
    toString: () => {
      throw new RangeError("toString threw");
    },
  };
  const nullPrototype = Object.assign(Object.create(null) as object, { code: "NULL_PROTO" });
  return [
    ["cyclic array", cyclicArray],
    ["cyclic object", cyclicObject],
    ["self-caused error", selfCaused],
    ["cause cycle", first],
    ["symbol", Symbol("thrown")],
    ["frozen error", frozenError],
    ["frozen object", frozenObject],
    ["throwing message getter", throwingMessage],
    ["throwing code getter", throwingCode],
    ["throwing toString", throwingToString],
    ["null-prototype object", nullPrototype],
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
    ["empty string", ""],
    ["false", false],
    ["bigint", 42n],
    ["plain error", new Error("plain")],
  ];
}
