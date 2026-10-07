// /app/__tests__/dependencyOverrides.test.ts
//
// The `overrides` block in package.json only ever grew. Every transitive CVE
// added an entry; nothing removed one. By the time anyone looked it held 29
// entries, three of them dead and four of them exact pins quietly blocking the
// updates they were added to deliver.
//
// Neither problem is visible by reading package.json, which is why neither was
// noticed. Both are obvious from the lockfile, so this asserts them on every
// run rather than waiting for someone to go looking.
//
// This shells out to the same script a developer runs (`node
// scripts/audit-overrides.mjs`) instead of importing it: the script is ESM and
// this Jest project is CJS, and re-implementing the check here would put the
// rule in two places -- which is the failure mode the script exists to fix.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

describe("package.json overrides stay honest", () => {
  it("is clean: nothing dead, every exact pin justified", () => {
    // The two failures this prevents:
    //
    //   DEAD -- `hono` and `@hono/node-server` appeared ZERO times in
    //   package-lock.json. They constrained nothing and had outlived whatever
    //   once pulled hono in.
    //
    //   EXACT PIN -- `semver` sat pinned at 7.6.3 through 7.7.0 ... 7.8.5. The
    //   pin was added to fix a CVE and became the reason later fixes could not
    //   land. A caret range is the default; an exact pin has to name what a
    //   newer in-major release breaks (see dependency-overrides.json).
    //
    // On failure the script's stderr says which entry and what to do about it.
    expect(() =>
      execFileSync("node", ["scripts/audit-overrides.mjs"], {
        cwd: join(__dirname, ".."),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
