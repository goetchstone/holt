// /app/src/lib/leadMagnet.ts
//
// Lead-magnet intake: a public email-capture (CMS leadMagnet block) lands
// here. Create-or-bump semantics mirror the rest of lead handling: an
// existing ACTIVE lead for the email is touched (sourceDetail appended
// conceptually — we keep the newest tag) instead of duplicated; everything
// else creates a NEW WEBSITE lead with sourceDetail `lead-magnet:<tag>`.

import { prisma } from "@/lib/prisma";

const ACTIVE_LEAD_STATUSES = ["NEW", "ASSIGNED", "CONTACTED"] as const;

export function normalizeLeadEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  // Light shape check — the rate limiter and honeypot do the real abuse work.
  if (e.length < 5 || e.length > 200 || !e.includes("@") || !e.includes(".")) return null;
  return e;
}

export function leadMagnetSourceDetail(sourceTag: string): string {
  const tag =
    sourceTag
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 60) || "general";
  return `lead-magnet:${tag}`;
}

export interface LeadMagnetSignup {
  email: string;
  name?: string | null;
  sourceTag?: string | null;
}

export async function ingestLeadMagnetSignup(
  input: LeadMagnetSignup,
): Promise<{ created: boolean } | null> {
  const email = normalizeLeadEmail(input.email);
  if (!email) return null;
  const sourceDetail = leadMagnetSourceDetail(input.sourceTag ?? "");

  const existing = await prisma.lead.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      status: { in: [...ACTIVE_LEAD_STATUSES] },
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.lead.update({
      where: { id: existing.id },
      data: { sourceDetail },
    });
    return { created: false };
  }

  const name = (input.name ?? "").trim();
  const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
  await prisma.lead.create({
    data: {
      source: "WEBSITE",
      sourceDetail,
      email,
      firstName: firstName || null,
      lastName: rest.length > 0 ? rest.join(" ") : null,
    },
  });
  return { created: true };
}
