// /app/__tests__/__mocks__/uuidShim.js
//
// CJS shim for uuid@14 in Jest only. uuid v14 dropped the CJS build;
// Jest (running ts-jest → CommonJS output) can't consume the ESM dist.
// This shim covers the subset next-auth imports transitively through
// getServerSession. Production code uses the real uuid@14 via Next.js /
// the app runtime, never this file.

function randomHex(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function v4() {
  return (
    randomHex(8) +
    "-" +
    randomHex(4) +
    "-4" +
    randomHex(3) +
    "-" +
    ((8 + Math.floor(Math.random() * 4)).toString(16)) +
    randomHex(3) +
    "-" +
    randomHex(12)
  );
}

const NIL = "00000000-0000-0000-0000-000000000000";
const MAX = "ffffffff-ffff-ffff-ffff-ffffffffffff";

module.exports = {
  v1: v4,
  v3: v4,
  v4,
  v5: v4,
  v6: v4,
  v7: v4,
  NIL,
  MAX,
  validate: () => true,
  version: () => 4,
  parse: () => new Uint8Array(16),
  stringify: () => NIL,
};
