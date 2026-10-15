// /app/__tests__/privateTempFile.test.ts
//
// The database restore spools a full copy of the database to a temp file. It
// used to be `$TMPDIR/holt-restore-<ms>-<pid>.sql`: guessable, in a shared
// directory, mode 0644 (CodeQL js/insecure-temporary-file #20,
// js/file-system-race #22). These run against the real filesystem: the
// property under test is what the OS reports about the file, which a mock
// could only repeat back.

import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

import { createPrivateTempFile } from "@/lib/privateTempFile";

const isPosix = process.platform !== "win32";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("createPrivateTempFile", () => {
  it("writes into a fresh 0700 directory, file mode 0600", async () => {
    const tmp = await createPrivateTempFile("holt-test-", "upload.sql");
    try {
      tmp.stream.end("-- PostgreSQL database dump\n");
      await finished(tmp.stream);

      expect(path.basename(tmp.path)).toBe("upload.sql");
      if (isPosix) {
        expect((await stat(path.dirname(tmp.path))).mode & 0o777).toBe(0o700);
        expect((await stat(tmp.path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await tmp.dispose();
    }
  });

  it("gives every call its own unguessable directory", async () => {
    const a = await createPrivateTempFile("holt-test-", "upload.sql");
    const b = await createPrivateTempFile("holt-test-", "upload.sql");
    try {
      expect(path.dirname(a.path)).not.toBe(path.dirname(b.path));
      expect(path.basename(path.dirname(a.path))).toMatch(/^holt-test-.{6,}$/);
    } finally {
      a.stream.end();
      b.stream.end();
      await a.dispose();
      await b.dispose();
    }
  });

  it("dispose removes the directory and may be called twice", async () => {
    const tmp = await createPrivateTempFile("holt-test-", "upload.sql");
    tmp.stream.end("x");
    await finished(tmp.stream);
    await tmp.dispose();
    await tmp.dispose();
    expect(await exists(path.dirname(tmp.path))).toBe(false);
  });
});
