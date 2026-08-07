// /app/src/pages/api/feedback/index.ts
//
// Creates a GitHub issue from in-app feedback. Uses GitHub App authentication
// (JWT + installation token) so no personal access token is needed.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { createIssue, isConfigured } from "@/lib/githubApp";
import { logError } from "@/lib/logger";

const LABEL_MAP: Record<string, string[]> = {
  bug: ["bug"],
  data: ["data"],
  enhancement: ["enhancement"],
  question: ["question"],
};

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const { category, area, description, pageUrl, userAgent } = req.body as {
    category: string;
    area?: string;
    description: string;
    pageUrl?: string;
    userAgent?: string;
  };

  if (!category || !description) {
    return res.status(400).json({ error: "Category and description are required" });
  }

  if (!(await isConfigured())) {
    return res
      .status(201)
      .json({ fallback: true, message: "Feedback recorded (GitHub App not configured)" });
  }

  const prefixMap: Record<string, string> = {
    bug: "[Bug]",
    data: "[Data]",
    enhancement: "[Feature]",
    question: "[Question]",
  };

  const prefix = prefixMap[category] || "[Feedback]";
  const title = `${prefix} ${area ? `${area}: ` : ""}${description.substring(0, 80)}`;

  const device = parseDevice(userAgent || "");

  const body = [
    `**Reported by:** ${session.user?.email || "Unknown"}`,
    `**Category:** ${category}`,
    area ? `**Area:** ${area}` : null,
    `**Page:** ${pageUrl || "N/A"}`,
    device ? `**Device:** ${device}` : null,
    "",
    "---",
    "",
    description,
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const issue = await createIssue({
      title,
      body,
      labels: LABEL_MAP[category] || [],
    });

    return res.status(201).json({ issueNumber: issue.number, url: issue.url });
  } catch (error) {
    logError("GitHub issue creation failed", error);
    return res.status(502).json({ error: "Failed to create GitHub issue" });
  }
}

// Self-service: any signed-in staff member can submit in-app feedback.
export default requirePermission("staff.self", handler);

function parseDevice(ua: string): string {
  if (ua.includes("iPad")) return "iPad";
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Mac")) return "Mac";
  if (ua.includes("Windows")) return "Windows";
  return "";
}
