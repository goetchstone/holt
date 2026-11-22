// /app/__tests__/staffEmailLookupRatchet.test.ts
//
// Bug class: a route finding "who is the caller" by `StaffMember.email`. Every
// gate resolves the caller by the session's User id, and anyone holding
// staff.manage can write a staff member's email, so an email-keyed lookup
// lets them decide whose row a session acts as. Until 2026-11-21 thirteen
// routes did exactly that (opening tills, the pipeline, service notes, order
// creation, the active store). They now call `sessionStaffMember`
// (lib/auth/roleAssignment.ts), whose behaviour is tested against a real
// database in integration/sessionStaffIdentity.integration.test.ts.
//
// This is a source-text check, which is only legitimate for a "no path may go
// around the shared lookup" invariant like this one (CLAUDE.md rules 57, 65).
// It fails when any call on `staffMember` under src has `email` in its
// `where`, unless the file is listed below with the reason it is matching an
// email nobody signed in with yet. It fails in both directions: a listed file
// whose lookups have gone (or whose count changed) is a stale manifest.
//
// What it cannot see: a `where` built in a variable and passed by name. That
// shape does not occur under src today.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..", "src");

/**
 * The email-keyed StaffMember lookups that are allowed, by file, with how
 * many each holds. Each matches an address someone is signing in or asking a
 * reset for, before there is a session to resolve by id.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "lib/auth/authProviders.ts": {
    count: 2,
    reason:
      "Local sign-in: the email typed on the sign-in form is the credential being checked, before any session exists.",
  },
  "lib/auth/passwordReset.ts": {
    count: 1,
    reason:
      "A reset request names an email; there is no session, and the reply never says whether it matched.",
  },
  "pages/api/auth/[...nextauth].ts": {
    count: 1,
    reason:
      "First sign-in links an unlinked staff row (userId null) to the User the identity provider just verified by that email.",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** The text from `open` (a `(` or `{`) to its matching close, inclusive. */
function balanced(text: string, open: number): string {
  const close = text[open] === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const STAFF_CALL = /\bstaffMember\.\w+\(/g;
// `email` as a key: `email:`, or the shorthand `{ email }` / `{ email, ... }`.
const EMAIL_KEY = /(?:^|[{,\s])email\s*(?::|,|\})/;
// "Has an email at all" filters a list; it names no one, so it is not a lookup.
const HAS_EMAIL = /\bemail\s*:\s*\{\s*not\s*:\s*null\s*\}/g;

/** How many `staffMember.*(...)` calls in `source` have `email` in their `where`. */
function emailKeyedStaffLookups(source: string): number {
  let count = 0;
  for (const m of source.matchAll(STAFF_CALL)) {
    const args = balanced(source, m.index + m[0].length - 1);
    const where = /\bwhere\s*:\s*\{/.exec(args);
    if (!where) continue;
    const clause = balanced(args, where.index + where[0].length - 1).replace(HAS_EMAIL, "");
    if (EMAIL_KEY.test(clause)) count++;
  }
  return count;
}

describe("staff lookups are keyed by the session's User id, never an email", () => {
  it("the matcher catches every shape the routes used, and only those", () => {
    const hits = [
      "prisma.staffMember.findUnique({ where: { email: session.user.email }, select: { id: true } })",
      "tx.staffMember.findFirst({ where: { email }, select: { displayName: true } })",
      'client.staffMember.findFirst({\n  where: { email: session.user?.email || "" },\n})',
      "prisma.staffMember.update({ where: { email: e }, data: {} })",
      "prisma.staffMember.findFirst({ where: { email: { equals: x, mode: 'insensitive' } } })",
    ];
    const misses = [
      "prisma.staffMember.findFirst({ where: { userId, isActive: true }, select: { email: true } })",
      "prisma.staffMember.findUnique({ where: { id }, select: { id: true, email: true } })",
      "prisma.user.findUnique({ where: { email } })",
      "prisma.staffMember.update({ where: { id }, data: { email } })",
      "prisma.staffMember.findMany({ where: { isActive: true, email: { not: null } } })",
    ];
    for (const s of hits) expect([s, emailKeyedStaffLookups(s)]).toEqual([s, 1]);
    for (const s of misses) expect([s, emailKeyedStaffLookups(s)]).toEqual([s, 0]);
  });

  it("no file under src looks a staff member up by email, beyond the listed sign-in paths", () => {
    const found: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const n = emailKeyedStaffLookups(fs.readFileSync(file, "utf8"));
      if (n > 0) found[path.relative(SRC, file).split(path.sep).join("/")] = n;
    }
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.count]));
    expect(found).toEqual(allowed);
  });

  it("every allowed exception carries its reason", () => {
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect([file, entry.reason.trim().length > 20]).toEqual([file, true]);
    }
  });
});
