// app/eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import nextConfig from "eslint-config-next";
import prettier from "eslint-config-prettier";
import sonarjs from "eslint-plugin-sonarjs";

// eslint-plugin-sonarjs catches the SonarSource TypeScript-rule violations
// that have been the most-recurring cleanup pattern post-PR. Rather than
// import the full recommended preset (269 rules, lots of style/naming
// noise), we register only the rules that map to the exact failures we've
// hit on recent PRs:
//
// - sonarjs/no-nested-conditional       → S3358 nested ternary in JSX
// - sonarjs/cognitive-complexity        → S3776 (threshold 15)
// - sonarjs/no-nested-functions         → S2004 deeply nested functions
// - sonarjs/unused-import               → S1128 unused imports
// - sonarjs/no-unused-collection        → unused collections
// - sonarjs/different-types-comparison  → wrong-type comparisons
//
// Severity policy: warn-only. Existing-code debt should not block CI;
// `npm run validate` already enforces "0 errors" so warns surface
// signal without breaking the build. New code should not add a warn-level
// violation; the point is to surface the issue locally during the diff.
//
// These rules are what remains of the SonarQube scan, removed 2026-10-16
// (CodeQL in CI covers the security analysis). SonarQube rules with no
// open-source port -- S6759 (readonly props), S6772 (ambiguous JSX
// spacing), S6819/S6848 (interactive a11y), S6853 (form labels), S7735
// (negated conditions), S7741 (typeof undefined), S7760 (default param) --
// are no longer checked by anything and need a human-eye pass.

export default defineConfig([
  ...nextConfig,
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"]),
  {
    plugins: { sonarjs },
    rules: {
      // Plain JS (next.config.js, the scripts/*.mjs launchers) gets the base
      // rule; TS files swap it for the TS-aware one in the block below.
      "no-unused-vars": "warn",
      // React Compiler rules (new in eslint-config-next 16). Downgrade to
      // warn for existing code; fix incrementally rather than blocking CI.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/globals": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/static-components": "warn",
      // sonarjs — focused subset (see top-of-file rationale).
      "sonarjs/no-nested-conditional": "warn",
      "sonarjs/cognitive-complexity": ["warn", 15],
      "sonarjs/no-nested-functions": "warn",
      "sonarjs/unused-import": "warn",
      "sonarjs/no-unused-collection": "warn",
      "sonarjs/different-types-comparison": "warn",
    },
  },
  {
    // The same files eslint-config-next's "next/typescript" block registers the
    // @typescript-eslint plugin for. Applying these rules to every file made
    // eslint exit 2 ("could not find plugin") on any .js/.mjs file.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Base ESLint no-unused-vars is disabled in favor of the TS-aware version
      // (typescript-eslint's documented requirement): the base rule can't parse
      // TS type-position params, function-type aliases, or interface method
      // signatures and emits false positives the @typescript-eslint rule
      // correctly ignores. Only the TS rule runs.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);
