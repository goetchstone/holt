// /app/src/lib/privateTempFile.ts
//
// A temp file that nobody else on the host can predict, pre-create, read or
// swap.
//
// The database restore used to spool its upload to
// `$TMPDIR/holt-restore-<Date.now()>-<pid>.sql`: a guessable name in a shared,
// world-writable directory, created with the default 0644 mode. Another local
// user could read the whole database dump while it sat there, or plant a
// symlink or their own file at the name first and change its contents between
// validation and `psql` reading it (CodeQL js/insecure-temporary-file #20,
// js/file-system-race #22). In the production container /tmp is not shared,
// but a developer's machine and a non-container deployment are.
//
// mkdtemp makes a fresh directory with an unguessable suffix and mode 0700, so
// only this user can see into it; the file inside is created exclusively
// ("wx", fails if anything already exists) with mode 0600.

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface PrivateTempFile {
  /** Absolute path of the file, inside its own 0700 directory. */
  path: string;
  /** A write stream that created the file exclusively, mode 0600. */
  stream: WriteStream;
  /** Remove the file and its directory. Safe to call more than once. */
  dispose(): Promise<void>;
}

export async function createPrivateTempFile(
  prefix: string,
  filename: string,
): Promise<PrivateTempFile> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const filePath = path.join(dir, filename);
  const stream = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  return {
    path: filePath,
    stream,
    dispose: async () => {
      stream.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
