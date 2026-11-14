// /app/src/lib/staffRecord.ts
//
// The columns of a StaffMember that the staff screens are sent: an ALLOWLIST
// (CLAUDE.md principle 8). The staff routes used to read the whole row with an
// `include`, so the sign-in password hash and the register PIN hash went to
// the browser of everyone who manages staff. A PIN is 4 to 8 digits, so its
// hash falls to brute force in seconds once it is out. A column a migration
// adds stays on the server until someone lists it here.
//
// Types only: no Prisma runtime, so a screen may import it too.

import type { Prisma } from "@prisma/client";

export const STAFF_RECORD_SELECT = {
  id: true,
  userId: true,
  displayName: true,
  aliases: true,
  email: true,
  followUpEmailOff: true,
  tagPrintMode: true,
  role: true,
  roleId: true,
  defaultStore: true,
  activeStoreLocationId: true,
  isActive: true,
  isDesigner: true,
  commissionPlanId: true,
  protectionCommissionPlanId: true,
  lastLoginAt: true,
  lastSeenAt: true,
  created: true,
  updated: true,
} as const satisfies Prisma.StaffMemberSelect;
