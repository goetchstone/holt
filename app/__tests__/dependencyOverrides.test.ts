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
import { pathToFileURL } from "node:url";

const SCRIPT = pathToFileURL(join(__dirname, "../scripts/audit-overrides.mjs")).href;

/** The real script, on a made-up package.json, so it can be seen to disagree. */
function audit(pkg: object, justified: object = {}) {
  const lock = {
    packages: {
      "node_modules/postcss": { version: "8.5.18" },
      "node_modules/sanitize-html": { version: "2.18.1" },
      "node_modules/glob": { version: "14.0.3" },
    },
  };
  const input = JSON.stringify({ pkg, lock, justified });
  const out = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { auditOverrides } from ${JSON.stringify(SCRIPT)};
       console.log(JSON.stringify(auditOverrides(${input})));`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as {
    dead: string[];
    unjustifiedPins: string[];
    literalOnDirect: string[];
  };
}

describe("an override on a direct dependency", () => {
  // Dependabot bumps the direct one. A literal override then disagrees with it, npm
  // refuses with EOVERRIDE, and the update never reaches anyone.
  it("is refused as a literal, the shape Dependabot's job failed on", () => {
    const { literalOnDirect } = audit({
      devDependencies: { postcss: "^8.5.18" },
      overrides: { postcss: "^8.5.18" },
    });
    expect(literalOnDirect).toEqual(["postcss: ^8.5.18"]);
  });

  it("is refused when it references a different package", () => {
    const { literalOnDirect } = audit({
      dependencies: { postcss: "^8.5.18", glob: "^14.0.3" },
      overrides: { postcss: "$glob" },
    });
    expect(literalOnDirect).toEqual(["postcss: $glob"]);
  });

  it("is accepted as a reference to itself", () => {
    const result = audit({
      devDependencies: { postcss: "^8.5.18" },
      overrides: { postcss: "$postcss" },
    });
    expect(result).toEqual({ dead: [], unjustifiedPins: [], literalOnDirect: [] });
  });

  it("still needs a reason when the direct one it references is an exact pin", () => {
    const pkg = {
      dependencies: { "sanitize-html": "2.18.1" },
      overrides: { "sanitize-html": "$sanitize-html" },
    };
    expect(audit(pkg).unjustifiedPins).toEqual(["sanitize-html: 2.18.1"]);
    expect(audit(pkg, { "sanitize-html": { reason: "x" } }).unjustifiedPins).toEqual([]);
  });

  it("leaves an override alone when it's version-scoped or not a direct dependency", () => {
    const { literalOnDirect } = audit({
      dependencies: { glob: "^14.0.3" },
      overrides: { "glob@10": "^14.0.3", postcss: "^8.5.18" },
    });
    expect(literalOnDirect).toEqual([]);
  });
});

describe("package.json overrides stay honest", () => {
  it("is clean: nothing dead, every exact pin justified, direct ones referenced", () => {
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
