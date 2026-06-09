// /app/src/pages/api/admin/settings/integrations.ts
//
// Manage encrypted third-party credentials for the organization. Plaintext is
// accepted on PUT, encrypted at rest (lib/secretCrypto via integrationCredentials),
// and NEVER returned -- GET yields masked entries (last four only). Provider +
// field names are validated against the shared integration catalog.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { isValidProviderField } from "@/lib/integrationCatalog";
import {
  deleteCredential,
  listMaskedCredentials,
  setCredential,
} from "@/lib/integrationCredentials";

export default requireAuthWithRole(["ADMIN"], async (req, res, session) => {
  if (req.method === "GET") return handleGet(res);
  if (req.method === "PUT") return handlePut(req, res, session);
  if (req.method === "DELETE") return handleDelete(req, res);
  res.setHeader("Allow", "GET, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
});

async function handleGet(res: NextApiResponse) {
  const credentials = await listMaskedCredentials(DEFAULT_ORG_ID);
  return res.json({ credentials });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { provider, field, value } = (req.body ?? {}) as {
    provider?: unknown;
    field?: unknown;
    value?: unknown;
  };

  if (typeof provider !== "string" || typeof field !== "string") {
    return res.status(400).json({ error: "provider and field are required" });
  }
  if (!isValidProviderField(provider, field)) {
    return res.status(400).json({ error: `Unknown integration field: ${provider}.${field}` });
  }
  if (typeof value !== "string" || value.trim() === "") {
    return res.status(400).json({ error: "value must be a non-empty string" });
  }

  try {
    await setCredential(
      DEFAULT_ORG_ID,
      provider,
      field,
      value.trim(),
      session.user?.email ?? undefined,
    );
  } catch (err) {
    logError("Failed to store integration credential", err, { provider, field });
    return res.status(500).json({ error: "Failed to save credential" });
  }

  const credentials = await listMaskedCredentials(DEFAULT_ORG_ID);
  return res.json({ credentials });
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const { provider, field } = (req.body ?? {}) as { provider?: unknown; field?: unknown };
  if (typeof provider !== "string" || typeof field !== "string") {
    return res.status(400).json({ error: "provider and field are required" });
  }

  try {
    await deleteCredential(DEFAULT_ORG_ID, provider, field);
  } catch (err) {
    logError("Failed to delete integration credential", err, { provider, field });
    return res.status(500).json({ error: "Failed to delete credential" });
  }

  const credentials = await listMaskedCredentials(DEFAULT_ORG_ID);
  return res.json({ credentials });
}
