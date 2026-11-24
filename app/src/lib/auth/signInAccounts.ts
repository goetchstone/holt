// /app/src/lib/auth/signInAccounts.ts
//
// The NextAuth adapter, with its one write that joins a sign-in to a person
// (Account, through linkAccount) guarded and recorded (2026-11-21).
//
// An Account row says "this Google/Okta/Azure account signs in as this User".
// lib/auth/freshOAuthSignIn.ts keeps NextAuth from linking onto whoever is
// already signed in at the browser; this is the second layer, at the write
// itself, for any path that reaches it.
//
// The rule: never link an account onto a User a staff member already signs in
// as. The one link NextAuth makes in a fresh sign-in is onto a User it created a
// moment before in the same callback (core/lib/callback-handler.js: createUser,
// then linkAccount), and that User has no staff member yet -- the jwt callback
// joins one to it afterwards. So a first sign-in passes and needs no exception
// of its own. The links refused are the ones onto an existing person: the
// signed-in user's (the hole above) and, were it ever turned on,
// allowDangerousEmailAccountLinking's link by email. Joining a second sign-in
// to someone is a decision for an admin to make on purpose, and nothing in Holt
// makes it yet.
//
// NextAuth wraps every adapter method and renames whatever it throws to
// "LinkAccountError" (core/errors.js adapterErrorHandler), so a refusal here
// reaches the browser as NextAuth's generic "Callback" error, not a message of
// its own. The audit entry and the log line are where it says what happened.

import { PrismaAdapter } from "@next-auth/prisma-adapter";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import type { EventCallbacks } from "next-auth";
import { prisma } from "@/lib/prisma";
import { auditLog } from "@/lib/audit";
import { logger } from "@/lib/logger";

export class SignInLinkRefusedError extends Error {
  constructor() {
    super("That sign-in can't be joined to someone who already has one.");
    this.name = "SignInLinkRefusedError";
  }
}

function linkFacts(account: Pick<AdapterAccount, "provider" | "providerAccountId" | "userId">) {
  return {
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    userId: account.userId,
  };
}

export function signInAccountsAdapter(): Adapter {
  const adapter = PrismaAdapter(prisma);
  const linkAccount = adapter.linkAccount!;
  return {
    ...adapter,
    async linkAccount(account: AdapterAccount) {
      const staff = await prisma.staffMember.findFirst({
        where: { userId: account.userId },
        select: { id: true, displayName: true },
      });
      if (staff) {
        logger.warn("Refused to join a sign-in account to an existing staff member", {
          ...linkFacts(account),
          staffId: staff.id,
        });
        await auditLog("SIGN_IN_LINK_REFUSED", `${account.provider} sign-in`, {
          summary: `A ${account.provider} account was refused as a sign-in for ${staff.displayName}`,
          target: { type: "staff", id: staff.id },
          details: linkFacts(account),
        });
        throw new SignInLinkRefusedError();
      }
      return linkAccount(account);
    },
  };
}

/** NextAuth's linkAccount event: every account joined to a User goes on the audit trail. */
export const recordSignInLink: EventCallbacks["linkAccount"] = async ({
  user,
  account,
  profile,
}) => {
  const who = profile.email ?? user.email ?? "unknown";
  await auditLog("SIGN_IN_LINKED", who, {
    summary: `${account.provider} account linked as the sign-in for ${user.email ?? user.id}`,
    details: linkFacts({ ...account, userId: user.id }),
  });
};
