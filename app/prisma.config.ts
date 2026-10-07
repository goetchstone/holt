// app/prisma.config.ts
//
// Prisma CLI configuration (generate, migrate, db push).
// Runtime PrismaClient uses the adapter passed in lib/prisma.ts instead.

// Env loading is explicit rather than `import "dotenv/config"`, which resolves
// to `<cwd>/.env` -- i.e. `app/.env`, a file no documented step ever creates.
// The result was that `npx prisma migrate deploy` from `app/` failed on an
// unset DATABASE_URL unless you knew to export it by hand: a wall on a first
// run, and the kind of thing you only learn by hitting it.
//
// Precedence, most specific first:
//   1. an already-exported DATABASE_URL  (CI, one-off overrides)
//   2. app/.env.local                    (where local dev keeps it)
//   3. ../.env                           (what docker compose reads)

import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";
import dotenv from "dotenv";

for (const candidate of [path.join(__dirname, ".env.local"), path.join(__dirname, "..", ".env")]) {
  if (fs.existsSync(candidate)) {
    // override:false preserves the precedence above -- the first file to
    // supply a value wins, and an exported variable beats both.
    dotenv.config({ path: candidate, override: false });
  }
}

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
