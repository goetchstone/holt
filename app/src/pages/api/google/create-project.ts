// /app/src/pages/api/google/create-project.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { google } from "googleapis";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Extra check beyond role: the Google Drive call needs an OAuth
  // accessToken on the session, not just staff membership.
  if (!(session as any)?.accessToken) {
    return res
      .status(401)
      .json({ error: "Authentication token is missing. Please sign out and sign back in." });
  }

  const { customerLastName } = req.body;
  if (!customerLastName || typeof customerLastName !== "string" || customerLastName.trim() === "") {
    return res.status(400).json({ error: "Customer last name is required." });
  }

  // The Drive folder new project folders go under, and the Slides deck copied
  // into each, are per-deployment configuration (Admin -> Settings ->
  // Integrations), NOT hardcoded: a baked-in id pointed every deployment at one
  // pilot's Drive. Unset -> refuse rather than write into the wrong account.
  const { drive: driveConfig, slides: slidesConfig } = (await getAppSettings()).google;
  const rootFolderId = driveConfig.projectsRootFolderId;
  const templatePresentationId = slidesConfig.templatePresentationId;
  if (!rootFolderId || !templatePresentationId) {
    return res.status(503).json({
      error:
        "Google Drive projects are not configured. Set the projects folder and Slides template in Settings → Integrations.",
    });
  }

  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: (session as any).accessToken });
    const drive = google.drive({ version: "v3", auth });

    const year = new Date().getFullYear();
    const mainFolderName = `${customerLastName.trim()}-${year}`;

    // 1. Create the main project folder
    const mainFolder = await drive.files.create({
      requestBody: {
        name: mainFolderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [rootFolderId],
      },
      fields: "id",
      // CORRECTED: This is required for creating content in a Shared Drive
      supportsAllDrives: true,
    });

    const mainFolderId = mainFolder.data.id;
    if (!mainFolderId) {
      throw new Error("Failed to create main project folder.");
    }

    // 2. Create the set of subfolders
    let presentationFolderId: string | null = null;
    for (const folderName of driveConfig.projectSubfolders) {
      const createdSubfolder = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [mainFolderId],
        },
        fields: "id",
        supportsAllDrives: true,
      });
      if (folderName === "Presentation") {
        presentationFolderId = createdSubfolder.data.id ?? null;
      }
    }

    if (!presentationFolderId) {
      throw new Error("Could not find or create the 'Presentation' subfolder.");
    }

    // 3. Copy the presentation template and rename it
    await drive.files.copy({
      fileId: templatePresentationId,
      requestBody: {
        name: `${customerLastName.trim()}-${year}-Presentation`,
        parents: [presentationFolderId],
      },
      supportsAllDrives: true,
    });

    res.status(200).json({ message: `Project folder '${mainFolderName}' created successfully!` });
  } catch (error: unknown) {
    logError("Google Drive API Error", error);
    res.status(500).json({
      error:
        "An error occurred while creating the project folder. You may need to sign out and sign back in to refresh permissions.",
    });
  }
}

// Design-consultation project folders (Windows, Rugs, Fabrics, Furniture...)
// -- a designer's tool; register/warehouse/marketing have no use for it.
export default requirePermission("sales.lead", handler);
