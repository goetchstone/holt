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
};

const sharedProject = {
  maxWorkers: 1,
  transform: sharedTransform,
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // uuid@14 is ESM-only; Jest (running ts-jest → CommonJS) cannot
    // parse its dist. Route the module to a thin CJS shim used only in
    // tests. Production runs against the real uuid@14 via Next.js.
    "^uuid$": "<rootDir>/__tests__/__mocks__/uuidShim.js",
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
    },
    {
      ...sharedProject,
      displayName: "performance",
      testEnvironment: "node",
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
