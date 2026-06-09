// /app/src/pages/api/google/create-project.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { google } from "googleapis";
import { logError } from "@/lib/logger";

// --- Values from your requirements ---
const ROOT_FOLDER_ID = "1zlCFD_X19sw6PyFsTGMuhTE_buAv-mFK";
const TEMPLATE_PRESENTATION_ID = "14R696lLFtEjGAOoZt2XBo_UkBWVRo7aaHywHOqi4Mfs";
// ------------------------------------

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORRECTED: Use getServerSession for reliable server-side session retrieval
  const session = await getServerSession(req, res, authOptions);

  if (!(session as any)?.accessToken) {
    return res
      .status(401)
      .json({ error: "Authentication token is missing. Please sign out and sign back in." });
  }

  const { customerLastName } = req.body;
  if (!customerLastName || typeof customerLastName !== "string" || customerLastName.trim() === "") {
    return res.status(400).json({ error: "Customer last name is required." });
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
        parents: [ROOT_FOLDER_ID],
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
    const subfolders = ["Windows", "Rugs", "Fabrics", "Furniture", "Photos", "Presentation"];
    let presentationFolderId: string | null = null;

    for (const folderName of subfolders) {
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
      fileId: TEMPLATE_PRESENTATION_ID,
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
