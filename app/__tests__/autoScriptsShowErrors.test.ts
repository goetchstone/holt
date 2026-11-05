// /app/__tests__/autoScriptsShowErrors.test.ts
//
// `curl -sf` throws away the reason a scheduled job failed: -s hides curl's own error and -f
// hides the body. A job that died left nothing to read. -sS keeps the error. A source-text
// tripwire on purpose (rule 57): the class is "this flag must not appear in any scheduled
// script", and nothing runs these scripts in a test.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = join(__dirname, "..", "..", "scripts");

describe("scheduled scripts", () => {
  const names = readdirSync(SCRIPTS).filter((name) => /^auto-.*\.sh$/.test(name));

  it("finds them", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s says why a request failed", (name) => {
    expect(readFileSync(join(SCRIPTS, name), "utf8")).not.toMatch(/curl\s+-[a-zA-Z]*(?<!S)sf\b/);
  });
});
