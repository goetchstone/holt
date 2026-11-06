// /app/src/pages/api/automations/gmail-import.ts
//
// DEPRECATED ALIAS for POST /api/automations/source-import.
//
// "Gmail" is how ONE adapter (the POS) receives its reports. Naming a
// transport in the URL was the same mistake as hardcoding one state's
// tax-district short name in the tax lookup: one deployment's fact,
// hardcoded where the general thing belongs (CLAUDE.md rule 61).
//
// This file stays because a cron installed before Admin > Automations may still
// call this exact path. Renaming a URL that a scheduled job on someone else's
// host calls every night is how a nightly import dies silently for a week. It
// delegates -- no duplicated auth, no duplicated orchestration, nothing to
// drift.
//
// Remove it once every deployment's cron has been repointed. That is a
// coordination step, not a code change.

import type { NextApiRequest, NextApiResponse } from "next";
import sourceImportHandler from "@/pages/api/automations/source-import";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return sourceImportHandler(req, res);
}
