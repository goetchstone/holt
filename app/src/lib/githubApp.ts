// /app/src/lib/githubApp.ts
//
// GitHub App authentication for creating issues. Uses JWT + installation
// token flow so no personal access token is needed.
//
// Required env vars:
//   GITHUB_APP_ID           - numeric app ID
//   GITHUB_APP_PRIVATE_KEY  - PEM private key (with literal \n for newlines)
//   GITHUB_INSTALLATION_ID  - numeric installation ID
// Optional env vars (required only when the GitHub feedback integration is enabled):
//   GITHUB_REPO_OWNER       - org or user that owns the issues repo
//   GITHUB_REPO_NAME        - repo name that feedback issues are filed against

import jwt from "jsonwebtoken";
import { resolveCredential } from "@/lib/integrationCredentials";

const API_BASE = "https://api.github.com";

let cachedToken: { token: string; expiresAt: number } | null = null;

// Repo coordinates are set per deployment (DB-first via Settings, env fallback)
// so the in-app feedback button files issues against the operator's own repo.
export async function getRepoCoordinates(): Promise<{ owner: string; repo: string }> {
  const owner = (await resolveCredential("github", "repoOwner", "GITHUB_REPO_OWNER")) ?? "";
  const repo = (await resolveCredential("github", "repoName", "GITHUB_REPO_NAME")) ?? "";
  return { owner, repo };
}

async function getConfig(): Promise<{ appId: string; privateKey: string; installationId: string }> {
  const appId = await resolveCredential("github", "appId", "GITHUB_APP_ID");
  const privateKey = await resolveCredential("github", "privateKey", "GITHUB_APP_PRIVATE_KEY");
  const installationId = await resolveCredential(
    "github",
    "installationId",
    "GITHUB_INSTALLATION_ID",
  );

  if (!appId || !privateKey || !installationId) {
    throw new Error(
      "GitHub App not configured: set the App ID, private key, and installation ID in " +
        "Settings > Integrations or the GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / " +
        "GITHUB_INSTALLATION_ID environment variables.",
    );
  }

  // Handle escaped newlines (env vars store the PEM with literal \n)
  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"),
    installationId,
  };
}

function generateAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: Number.parseInt(appId, 10),
      iat: now - 60, // 60s clock drift allowance
      exp: now + 9 * 60, // 9 minutes (max is 10)
    },
    privateKey,
    { algorithm: "RS256" },
  );
}

export async function getInstallationToken(): Promise<string> {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const { appId, privateKey, installationId } = await getConfig();
  const appJWT = generateAppJWT(appId, privateKey);

  const response = await fetch(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJWT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };

  return data.token;
}

export async function isConfigured(): Promise<boolean> {
  const appId = await resolveCredential("github", "appId", "GITHUB_APP_ID");
  const privateKey = await resolveCredential("github", "privateKey", "GITHUB_APP_PRIVATE_KEY");
  const installationId = await resolveCredential(
    "github",
    "installationId",
    "GITHUB_INSTALLATION_ID",
  );
  return Boolean(appId && privateKey && installationId);
}

interface CreateIssueParams {
  title: string;
  body: string;
  labels?: string[];
}

interface CreateIssueResult {
  number: number;
  url: string;
}

export async function createIssue(params: CreateIssueParams): Promise<CreateIssueResult> {
  const token = await getInstallationToken();
  const { owner, repo } = await getRepoCoordinates();

  const response = await fetch(`${API_BASE}/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: params.title,
      body: params.body,
      labels: params.labels || [],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create issue: ${response.status} ${errorText}`);
  }

  const issue = await response.json();
  return { number: issue.number, url: issue.html_url };
}
