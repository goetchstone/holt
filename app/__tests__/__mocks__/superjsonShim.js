// /app/__tests__/__mocks__/superjsonShim.js
//
// CJS shim for superjson in Jest only. superjson is ESM-only ("type":"module")
// and ts-jest compiles tests to CommonJS, so the real dist can't be required.
// tRPC's initTRPC only needs the transformer's serialize/deserialize identity
// for these in-process caller tests (no wire round-trip happens), so a
// pass-through is sufficient. Production uses the real superjson via Next.js.

const identity = {
  serialize: (value) => ({ json: value, meta: undefined }),
  deserialize: (payload) => (payload && "json" in payload ? payload.json : payload),
  stringify: (value) => JSON.stringify(value),
  parse: (text) => JSON.parse(text),
};

module.exports = identity;
module.exports.default = identity;
