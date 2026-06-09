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
// signal without breaking the build. New code that introduces a warn-
// level violation still has to be fixed before the local Sonar gate
// (rule 48) lets the PR through. The point is to surface the issue
// locally during the diff, not double-block.
//
// Rules with NO open-source port (still Sonar-only): S6759 (readonly
// props), S6772 (ambiguous JSX spacing), S6819/S6848 (interactive
// a11y), S6853 (form labels), S7735 (negated conditions), S7741
// (typeof undefined), S7760 (default param). Those still need a
// human-eye pass before commit. CLAUDE.md "Code Quality" section
// names the gap.

export default defineConfig([
  ...nextConfig,
  prettier,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"]),
  {
    plugins: { sonarjs },
    rules: {
      // Base ESLint no-unused-vars is disabled in favor of the TS-aware version
      // (typescript-eslint's documented requirement): the base rule can't parse
      // TS type-position params, function-type aliases, or interface method
      // signatures and emits false positives the @typescript-eslint rule
      // correctly ignores. Only the TS rule runs.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
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
]);
