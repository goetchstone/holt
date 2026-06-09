// /app/src/lib/integrationCredentials.ts
//
// Server-only read/write for encrypted third-party credentials. A secret's
// plaintext is only ever in memory at the moment it is set (encrypt) or used
// (decrypt at the point the integration is actually called). Never return
// plaintext to a client -- use listMaskedCredentials for UI display.
//
// Thin Prisma + crypto wiring by design (CLAUDE.md rule 14): the testable
// logic lives in secretCrypto (unit-tested). This module is plain upsert/find
// wiring -- a real-DB integration test is the upgrade target once the fork's
// test database is provisioned.

import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret, lastFour } from "@/lib/secretCrypto";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { logError } from "@/lib/logger";

export interface MaskedCredential {
  provider: string;
  field: string;
  lastFour: string | null;
  updated: Date | null;
}

export async function setCredential(
  organizationId: number,
  provider: string,
  field: string,
  plaintext: string,
  actor?: string,
): Promise<void> {
  const ciphertext = encryptSecret(plaintext);
  const last = lastFour(plaintext);
  await prisma.integrationCredential.upsert({
    where: { organizationId_provider_field: { organizationId, provider, field } },
    create: {
      organizationId,
      provider,
      field,
      ciphertext,
      lastFour: last,
      createdBy: actor,
      updatedBy: actor,
    },
    update: { ciphertext, lastFour: last, updatedBy: actor },
  });
}

export async function getCredential(
  organizationId: number,
  provider: string,
  field: string,
): Promise<string | null> {
  const row = await prisma.integrationCredential.findUnique({
    where: { organizationId_provider_field: { organizationId, provider, field } },
    select: { ciphertext: true },
  });
  return row ? decryptSecret(row.ciphertext) : null;
}

export async function getProviderCredentials(
  organizationId: number,
  provider: string,
): Promise<Record<string, string>> {
  const rows = await prisma.integrationCredential.findMany({
    where: { organizationId, provider },
    select: { field: true, ciphertext: true },
  });
  const out: Record<string, string> = {};
  for (const row of rows) out[row.field] = decryptSecret(row.ciphertext);
  return out;
}

export async function listMaskedCredentials(organizationId: number): Promise<MaskedCredential[]> {
  return prisma.integrationCredential.findMany({
    where: { organizationId },
    select: { provider: true, field: true, lastFour: true, updated: true },
    orderBy: [{ provider: "asc" }, { field: "asc" }],
  });
}

export async function deleteCredential(
  organizationId: number,
  provider: string,
  field: string,
): Promise<void> {
  await prisma.integrationCredential.deleteMany({
    where: { organizationId, provider, field },
  });
}

/**
 * Resolve a single credential value, DB-first with an env fallback.
 *
 * This is the bridge that makes Settings-configured integrations actually take
 * effect: a value stored (encrypted) via the Settings UI wins; if none exists,
 * we fall back to the process env var so self-hosters who configure everything
 * through env keep working unchanged. Returns undefined when neither source has
 * a value, so callers can throw a clear "not configured" error.
 *
 * Never throws on a DB miss -- a transient DB error during credential lookup
 * falls back to env rather than taking the integration down.
 */
export async function resolveCredential(
  provider: string,
  field: string,
  envVar: string,
  organizationId: number = DEFAULT_ORG_ID,
): Promise<string | undefined> {
  try {
    const fromDb = await getCredential(organizationId, provider, field);
    if (fromDb && fromDb.trim()) return fromDb;
  } catch (err) {
    logError("resolveCredential DB lookup failed; falling back to env", err, {
      provider,
      field,
    });
  }
  const fromEnv = process.env[envVar];
  return fromEnv && fromEnv.trim() ? fromEnv : undefined;
}
