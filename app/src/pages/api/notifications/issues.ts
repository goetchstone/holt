// /app/src/pages/api/notifications/issues.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { isConfigured, getInstallationToken, getRepoCoordinates } from "@/lib/githubApp";
import { logError } from "@/lib/logger";

const API_BASE = "https://api.github.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface ClosedIssue {
  number: number;
  title: string;
  closedAt: string;
}

interface IssuesResponse {
  openCount: number;
  recentlyClosed: ClosedIssue[];
}

let cache: { data: IssuesResponse; timestamp: number } | null = null;

async function fetchIssuesData(): Promise<IssuesResponse> {
  const token = await getInstallationToken();
  const { owner, repo } = await getRepoCoordinates();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [openRes, closedRes] = await Promise.all([
    fetch(`${API_BASE}/repos/${owner}/${repo}/issues?state=open&per_page=100`, {
      headers,
    }),
    fetch(
      `${API_BASE}/repos/${owner}/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=10&since=${sevenDaysAgo}`,
      { headers },
    ),
  ]);

  if (!openRes.ok || !closedRes.ok) {
    throw new Error("Failed to fetch issues from GitHub");
  }

  const openIssues = await openRes.json();
  const closedIssues = await closedRes.json();

  return {
    openCount: Array.isArray(openIssues) ? openIssues.length : 0,
    recentlyClosed: (Array.isArray(closedIssues) ? closedIssues : []).map(
      (issue: { number: number; title: string; closed_at: string }) => ({
        number: issue.number,
        title: issue.title,
        closedAt: issue.closed_at,
      }),
    ),
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await isConfigured())) {
    return res.status(200).json({ openCount: 0, recentlyClosed: [] });
  }

  // Return cached data if still fresh
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return res.status(200).json(cache.data);
  }

  try {
    const data = await fetchIssuesData();
    cache = { data, timestamp: Date.now() };
    return res.status(200).json(data);
  } catch (err) {
    logError("Failed to fetch notification issues", err);
    // Return stale cache on error if available
    if (cache) {
      return res.status(200).json(cache.data);
    }
    return res.status(200).json({ openCount: 0, recentlyClosed: [] });
  }
}
