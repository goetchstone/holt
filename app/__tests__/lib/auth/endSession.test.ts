// /app/__tests__/lib/auth/endSession.test.ts
//
// Signing out stays signed out (lib/auth/endSession.ts).
//
// Every API response re-issues the session cookie, so a poll the screen sent
// just before a sign-out could answer just after it and put the session back.
// GAP-27's automatic sign-out did exactly that in the browser check
// (2026-10-31), landing on the sign-in screen with the session still live.
// The sign-in screen now finishes the job when, and only when, a sign-out sent
// it there.
//
// next-auth/react is stubbed: its signOut and getSession are network calls,
// and what is under test is the order and the conditions around them. The last
// block is a source tripwire for the "a sign-out that skips the helper" class
// (rule 57): one sign-out written the old way brings the race back for that
// button, and nothing else would notice.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const calls: string[] = [];
const getSession = jest.fn();
const signOut = jest.fn(async (opts: unknown) => {
  calls.push(`signOut ${JSON.stringify(opts)}`);
});
jest.mock("next-auth/react", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
  signOut: (opts: unknown) => signOut(opts),
}));

import { confirmSignedOut, leaveTo, signOutTo } from "@/lib/auth/endSession";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  calls.length = 0;
  getSession.mockReset();
  signOut.mockClear();
  storage = new MemoryStorage();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: storage,
    location: { assign: (url: string) => calls.push(`go ${url}`) },
  };
});

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

const SESSION = { user: { id: "ada" } };

describe("signing out", () => {
  it("signs out before leaving, and marks the tab for the sign-in screen", async () => {
    await signOutTo("/auth/login?reason=idle&callbackUrl=%2Fapp");
    expect(calls).toEqual([
      'signOut {"redirect":false}',
      "go /auth/login?reason=idle&callbackUrl=%2Fapp",
    ]);
    expect(storage.getItem("holt:signingOut")).toBe("1");
  });

  it("marks the tab when the session ended in another one", () => {
    leaveTo("/auth/login");
    expect(calls).toEqual(["go /auth/login"]);
    expect(storage.getItem("holt:signingOut")).toBe("1");
  });
});

describe("the sign-in screen", () => {
  it("signs out a session a late response put back", async () => {
    storage.setItem("holt:signingOut", "1");
    getSession.mockResolvedValueOnce(SESSION).mockResolvedValueOnce(null);
    await confirmSignedOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(storage.getItem("holt:signingOut")).toBeNull();
  });

  it("looks again, since its own first session read can race the sign-out", async () => {
    storage.setItem("holt:signingOut", "1");
    getSession
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValueOnce(null);
    await confirmSignedOut();
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it("gives up after three tries rather than looping", async () => {
    storage.setItem("holt:signingOut", "1");
    getSession.mockResolvedValue(SESSION);
    await confirmSignedOut();
    expect(signOut).toHaveBeenCalledTimes(3);
  });

  it("leaves a session alone when no sign-out sent it there: a link can't sign anyone out", async () => {
    getSession.mockResolvedValue(SESSION);
    await confirmSignedOut();
    expect(getSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does nothing more once the sign-out held", async () => {
    storage.setItem("holt:signingOut", "1");
    getSession.mockResolvedValue(null);
    await confirmSignedOut();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("with storage blocked", () => {
  beforeEach(() => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    (globalThis as { window?: { sessionStorage: unknown } }).window!.sessionStorage = {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    };
  });

  it("still signs out and leaves", async () => {
    await signOutTo("/auth/login");
    expect(calls).toEqual(['signOut {"redirect":false}', "go /auth/login"]);
  });

  it("the sign-in screen signs no one out", async () => {
    getSession.mockResolvedValue(SESSION);
    await confirmSignedOut();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("every sign-out goes through the helper", () => {
  const SRC = join(__dirname, "../../../src");
  const HELPER = "lib/auth/endSession.ts";

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it("calls next-auth's signOut nowhere else", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => relative(SRC, path) !== HELPER)
      .filter((path) => /\bsignOut\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("still finds the helper's own call, so the scan can see one", () => {
    expect(readFileSync(join(SRC, HELPER), "utf8")).toMatch(/\bsignOut\s*\(/);
  });
});
