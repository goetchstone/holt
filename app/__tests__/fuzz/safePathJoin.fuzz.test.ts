// /app/__tests__/fuzz/safePathJoin.fuzz.test.ts
//
// Property-based fuzzing of lib/safePathJoin.ts, the file-system boundary
// behind /api/uploads/[...path] and the image/PDF routes: URL path segments
// and stored image paths are resolved under a trusted root. Whatever the
// segments, the result must stay under the root or the call must throw
// PathTraversalError -- and ordinary file names must not be refused.

import path from "path";
import fc from "fast-check";
import { PathTraversalError, safePathJoin } from "@/lib/safePathJoin";
import { anyString } from "./support";

const ROOTS = ["/srv/holt/uploads", "/tmp/holt data/ünï", "relative/uploads"];

// Pieces attackers use to climb out of a directory, joined into segments.
const climbPiece = fc.constantFrom(
  "..",
  ".",
  "/",
  "\\",
  "../",
  "..\\",
  "%2e%2e",
  "%2f",
  "\u0000",
  "/etc/passwd",
  "uploads-evil",
  "~",
  "a",
  "é",
);
const segment = fc.oneof(
  fc.array(climbPiece, { minLength: 1, maxLength: 6 }).map((p) => p.join("")),
  anyString(20),
);
const segments = fc.array(fc.option(segment, { nil: undefined }), { maxLength: 5 });

// A file or directory name a real upload would have.
const plainName = fc
  .stringMatching(/^[A-Za-z0-9._ -]{1,30}$/)
  .filter((s) => s !== "." && s !== ".." && s.trim() === s);

describe("safePathJoin (lib/safePathJoin.ts)", () => {
  it("stays under the root or throws PathTraversalError -- nothing else", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ROOTS), segments, (root, segs) => {
        const absoluteRoot = path.resolve(root);
        let resolved: string;
        try {
          resolved = safePathJoin(root, ...segs);
        } catch (e) {
          expect(e).toBeInstanceOf(PathTraversalError);
          return;
        }
        expect(resolved === absoluteRoot || resolved.startsWith(absoluteRoot + path.sep)).toBe(
          true,
        );
        expect(path.relative(absoluteRoot, resolved).split(path.sep)).not.toContain("..");
        expect(resolved).not.toContain("\u0000");
      }),
    );
  });

  it("joins ordinary names exactly like path.join, including names containing '..'", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROOTS),
        fc.array(plainName, { minLength: 1, maxLength: 4 }),
        (root, names) => {
          expect(safePathJoin(root, ...names)).toBe(path.resolve(root, ...names));
        },
      ),
    );
  });
});
