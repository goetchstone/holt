// /app/src/pages/api/admin/email-look/[kind].ts
//
// GAP-37. PUT { subject, heading, intro, closing } saves a store's wording for one email
// (blank is the suggested wording), DELETE goes back to the suggested wording, and POST
// { look, wording } renders that email as it would go out, without saving, for the preview.
// The look itself saves through /api/admin/settings with the other settings. admin.settings.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { readEmailLook } from "@/lib/email/look";
import { sampleEmail } from "@/lib/email/samples";
import { isEmailKind, emailWordingProblem } from "@/lib/email/wordingCatalog";
import {
  EmailWordingError,
  readWordingBody,
  resetEmailWording,
  saveEmailWording,
} from "@/lib/email/wordingSettings";

async function preview(kind: unknown, body: Record<string, unknown>) {
  if (!isEmailKind(kind)) throw new EmailWordingError("No such email.", 404);
  const wording = readWordingBody(body.wording);
  const problem = emailWordingProblem(kind, wording);
  if (problem) throw new EmailWordingError(problem);
  const app = await getAppSettings();
  const draft = (body.look ?? {}) as Record<string, unknown>;
  const look = readEmailLook(
    {
      emailAccentColor: typeof draft.accent === "string" ? draft.accent : null,
      emailShowLogo: draft.showLogo === true,
      emailFooter: typeof draft.footer === "string" ? draft.footer : null,
      logoUrl: app.logoUrl,
    },
    process.env.NEXTAUTH_URL || "http://localhost:3000",
  );
  return sampleEmail(kind, app.companyName?.trim() || app.appName, { look, wording });
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { kind } = req.query;
  try {
    if (req.method === "PUT") {
      const actor = session.user?.email ?? null;
      return res.status(200).json(await saveEmailWording(prisma, kind, req.body, actor));
    }
    if (req.method === "DELETE") {
      await resetEmailWording(prisma, kind);
      return res.status(200).json({ ok: true });
    }
    if (req.method === "POST") {
      return res.status(200).json(await preview(kind, req.body ?? {}));
    }
    res.setHeader("Allow", "PUT, DELETE, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    if (err instanceof EmailWordingError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("/api/admin/email-look/[kind] error", err, { kind: String(kind) });
    return res.status(500).json({ error: "Couldn't do that to the email." });
  }
}

export default requirePermission("admin.settings", handler);
