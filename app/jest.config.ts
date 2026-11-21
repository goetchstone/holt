// /app/jest.config.ts

const sharedTransform = {
  "^.+\\.tsx?$": [
    "ts-jest",
    {
      // isolatedModules now lives in tsconfig.json (ts-jest >= 30 deprecated
      // it as a jest-side option).
      tsconfig: { moduleResolution: "node", module: "commonjs", jsx: "react-jsx" },
    },
  ],
  // @rgrove/parse-xml@5 is ESM-only. Unlike superjson below it gets
  // no shim: the DMARC tests exist to prove the REAL parser rejects DTDs and
  // resolves no external entities, so the real code is compiled to CommonJS
  // for Jest instead (see ESM_TRANSFORMED below).
  "^.+/node_modules/@rgrove/parse-xml/.+\\.js$": [
    "ts-jest",
    { tsconfig: { allowJs: true, module: "commonjs", moduleResolution: "node" } },
  ],
  // marked@18 is ESM-only too, and the same reasoning holds: the help center's
  // tests prove the REAL renderer's output is sanitized (lib/help/articles.ts).
  "^.+/node_modules/marked/.+\\.js$": [
    "ts-jest",
    { tsconfig: { allowJs: true, module: "commonjs", moduleResolution: "node" } },
  ],
  // sanitize-html (CommonJS) requires htmlparser2@12, which is ESM-only, as are
  // the four parser packages under it and entities. Node loads them for
  // sanitize-html in production (require of ESM); Jest cannot, so they are
  // compiled here, and the CMS and help-center tests sanitize with the REAL
  // parser. Until 2026-11-20 a blanket override pinned htmlparser2 to 9.1.0
  // instead, below the ^12 sanitize-html asks for (rule 53).
  "^.+/node_modules/(htmlparser2|domutils|domhandler|domelementtype|dom-serializer|entities)/.+\\.js$":
    ["ts-jest", { tsconfig: { allowJs: true, module: "commonjs", moduleResolution: "node" } }],
};

// node_modules packages Jest must transform rather than load as-is.
const ESM_TRANSFORMED = [
  "@rgrove/parse-xml",
  "marked",
  "htmlparser2",
  "domutils",
  "domhandler",
  "domelementtype",
  "dom-serializer",
  "entities",
];

const sharedProject = {
  maxWorkers: 1,
  transform: sharedTransform,
  // A listed package is compiled wherever npm puts it, nested under an unlisted
  // one included (sanitize-html/node_modules/htmlparser2 was, until 2026-11-20).
  transformIgnorePatterns: [
    `/node_modules/(?!(?:.+/node_modules/)?(?:${ESM_TRANSFORMED.join("|")})/)`,
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // superjson is ESM-only too; same CJS-shim approach. tRPC's transformer
    // only needs serialize/deserialize identity for in-process caller tests.
    "^superjson$": "<rootDir>/__tests__/__mocks__/superjsonShim.js",
  },
};

export default {
  projects: [
    {
      ...sharedProject,
      displayName: "unit",
      testEnvironment: "node",
      // No database URL reaches a unit test, whatever the shell exports.
      setupFiles: ["<rootDir>/jest.no-database.setup.ts"],
      // Pure unit tests — no DB, no I/O. Excludes the integration and
      // performance subdirectories so they only run via their own
      // selectProjects flag.
      testMatch: [
        "**/__tests__/**/*.test.ts",
        "!**/__tests__/integration/**",
        "!**/__tests__/performance/**",
      ],
    },
    {
      ...sharedProject,
      displayName: "integration",
      testEnvironment: "node",
      // Real-DB integration tests (Phase 0.6). Each test file is
      // expected to call resetTestDb() in beforeEach. The globalSetup
      // creates fbc_test_db (if missing) and runs migrations once per
      // Jest run.
      testMatch: ["**/__tests__/integration/**/*.test.ts"],
      globalSetup: "<rootDir>/jest.integration.setup.ts",
      // Stock and its journal agree after every test (ledger plan phase 4).
      setupFilesAfterEnv: ["<rootDir>/jest.integration.afterEach.ts"],
    },
    {
      ...sharedProject,
      displayName: "performance",
      testEnvironment: "node",
      setupFiles: ["<rootDir>/jest.no-database.setup.ts"],
      // Performance/sizing tests — in-memory only, no DB. Kept in a
      // separate project so they're skipped from the default unit run
      // (some are slow by nature) and from the integration project
      // (they don't need a DB).
      testMatch: ["**/__tests__/performance/**/*.test.ts"],
    },
  ],

  // No `coverageThreshold` here. Threshold enforcement moved to
  // `nyc check-coverage` invoked from `app/scripts/test-coverage.sh`
  // after merging unit + integration coverage (Phase 0.6.5, 2026-05-01).
  //
  // Why: Jest's `coverageThreshold` only sees one project at a time.
  // Phase 0.6.3 conversions moved code coverage from the unit project
  // to the integration project. Each conversion eroded the unit-only
  // floor (68 → 67 → 64) even though combined coverage didn't change.
  // The new gate runs both projects, merges their JSON coverage, and
  // checks thresholds against the merged data.
  //
  // Threshold values live in `scripts/test-coverage.sh` — single
  // source of truth.
  //
  // coveragePathIgnorePatterns stays at root level (per-project
  // placement is silently ignored in multi-project configs).

  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/.next/",
    "/prisma/",
    "/__tests__/",
    "/src/pages/_app.tsx",
    "/src/pages/_document.tsx",
  ],
};
