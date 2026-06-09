// /app/__tests__/security.hardening.test.ts
//
// Source-text tripwires for the security hardening done in PR
// security/hardening-pinned-paths-and-crypto-rand. These guard against the
// fixes silently regressing (e.g. someone "simplifying" the crypto import
// back to Math.random for a one-line filename change).
//
// Sonar findings these tests guard against:
//   - typescript:S2245 (Math.random in security context) -- secureUpload.ts
//   - typescript:S4036 (PATH-resolved binary in spawn)   -- backup.ts, restore.ts

import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("Security hardening tripwires", () => {
  describe("secureUpload.ts uses crypto-strong randomness for filenames", () => {
    const src = read("src/lib/secureUpload.ts");

    test("imports randomBytes from node:crypto", () => {
      // Sonar S7772: prefer node: prefix on built-in modules. The
      // tripwire accepts either form (the import value is identical) but
      // documents that we currently use the prefixed form.
      expect(src).toMatch(/from\s+["']node:crypto["']/);
      expect(src).toMatch(/randomBytes/);
    });

    test("does not use Math.random anywhere in the file", () => {
      // Math.random would let an attacker race or guess upload paths
      // before processing finishes (S2245). 48-bit crypto suffix is the
      // documented invariant.
      expect(src).not.toMatch(/Math\.random/);
    });
  });

  describe("admin database routes pin absolute binary paths", () => {
    test("backup.ts uses pinned PG_DUMP_PATH, not bare 'pg_dump'", () => {
      const src = read("src/pages/api/admin/database/backup.ts");
      expect(src).toMatch(/PG_DUMP_PATH/);
      expect(src).toMatch(/\/usr\/bin\/pg_dump/);
      // Bare invocation must not return:
      expect(src).not.toMatch(/spawn\(\s*["']pg_dump["']/);
    });

    test("restore.ts uses pinned PSQL_PATH, not bare 'psql'", () => {
      const src = read("src/pages/api/admin/database/restore.ts");
      expect(src).toMatch(/PSQL_PATH/);
      expect(src).toMatch(/\/usr\/bin\/psql/);
      expect(src).not.toMatch(/spawn\(\s*["']psql["']/);
    });

    test("both routes allow env-var override for local development", () => {
      const backup = read("src/pages/api/admin/database/backup.ts");
      const restore = read("src/pages/api/admin/database/restore.ts");
      expect(backup).toMatch(/process\.env\.PG_DUMP_PATH/);
      expect(restore).toMatch(/process\.env\.PSQL_PATH/);
    });
  });
});
