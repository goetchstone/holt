// /app/__tests__/safePathJoin.test.ts

import path from "path";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";

describe("safePathJoin", () => {
  const ROOT = "/data/uploads";

  it("joins simple segments under the root", () => {
    expect(safePathJoin(ROOT, "proposals", "123", "hero.jpg")).toBe(
      path.resolve(ROOT, "proposals", "123", "hero.jpg"),
    );
  });

  it("returns the root itself when no segments are passed", () => {
    expect(safePathJoin(ROOT)).toBe(path.resolve(ROOT));
  });

  it("ignores undefined / empty segments", () => {
    expect(safePathJoin(ROOT, undefined, "file.jpg", "")).toBe(path.resolve(ROOT, "file.jpg"));
  });

  it("throws on a bare '..' segment", () => {
    expect(() => safePathJoin(ROOT, "..")).toThrow(PathTraversalError);
  });

  it("throws on '../x' escape attempts", () => {
    expect(() => safePathJoin(ROOT, "../etc/passwd")).toThrow(PathTraversalError);
  });

  it("throws on embedded '/../' attempts", () => {
    expect(() => safePathJoin(ROOT, "proposals/../etc/passwd")).toThrow(PathTraversalError);
  });

  it("throws on absolute-path attempts via the second segment", () => {
    // path.resolve() would happily swap to /etc/passwd if we allowed this.
    expect(() => safePathJoin(ROOT, "/etc/passwd")).toThrow(PathTraversalError);
  });

  it("throws on NUL-byte injection", () => {
    expect(() => safePathJoin(ROOT, "file.jpg\u0000.php")).toThrow(PathTraversalError);
  });

  it("allows '..' as a substring of a filename", () => {
    // "a..b" is a legitimate filename, not a traversal.
    expect(safePathJoin(ROOT, "a..b.jpg")).toBe(path.resolve(ROOT, "a..b.jpg"));
  });

  it("normalizes redundant slashes inside a single segment", () => {
    expect(safePathJoin(ROOT, "proposals//123//hero.jpg")).toBe(
      path.resolve(ROOT, "proposals", "123", "hero.jpg"),
    );
  });
});
