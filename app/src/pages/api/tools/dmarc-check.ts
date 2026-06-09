// /app/src/pages/api/tools/dmarc-check.ts
// Server-side DNS lookups for SPF / DKIM / DMARC / MX records on a given
// domain. Public endpoint, rate-limited per IP. Returns parsed records +
// plain-English issues. Used by the /tools/dmarc-check landing page.

import type { NextApiRequest, NextApiResponse } from "next";
import { promises as dns } from "node:dns";
import { rateLimit } from "@/lib/rateLimit";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";

// Common DKIM selectors used by major mail providers. We probe these because
// DKIM selector names aren't discoverable from the domain itself — DNS gives
// no way to enumerate them, so we probe a curated list of the static selectors
// the major providers actually use. (Selectors that are dynamic per-account
// hashes — Amazon SES rotating keys, SparkPost scphNNNN, SendGrid sNNNNNN — are
// unguessable and deliberately omitted; the report analyzer surfaces those.)
// Selectors confirmed from real DMARC aggregate reports and live DNS are noted.
const DKIM_SELECTORS = [
  // Google Workspace
  "google",
  // Microsoft 365 / Outlook
  "selector1",
  "selector2",
  // DreamHost (confirmed: dreamhost._domainkey.akritos.com)
  "dreamhost",
  // Mailchimp (k1/k2/k3 seen in reports) + Mandrill transactional (mte1/mte2)
  "k1",
  "k2",
  "k3",
  "mte1",
  "mte2",
  // SendGrid
  "s1",
  "s2",
  "smtpapi",
  // Amazon SES (static fallback selector)
  "amazonses",
  // Postmark
  "pm",
  // Proton Mail
  "protonmail",
  "protonmail2",
  "protonmail3",
  // Zoho
  "zoho",
  "zmail",
  // Fastmail
  "fm1",
  "fm2",
  "fm3",
  // Mailgun (customer-chosen, these are the common ones)
  "mg",
  "mx",
  "pic",
  // Mailjet
  "mailjet",
  // Klaviyo
  "kl",
  "kl2",
  // Apple iCloud custom-domain
  "sig1",
  // Yahoo / AOL outbound
  "s2048",
  "s1024",
  // Generic / OpenDKIM / cPanel / GoDaddy / common defaults
  "default",
  "dkim",
  "mail",
  "email",
  "selector",
  "key1",
  "key2",
  "smtp",
  "mxvault",
] as const;

// Known mail-provider patterns we can identify from MX records. Helps the
// reader see "oh, we're on Google Workspace" without needing to interpret
// the raw MX values.
const MX_PROVIDERS: { match: RegExp; name: string }[] = [
  { match: /google\.com$|googlemail\.com$/i, name: "Google Workspace" },
  { match: /outlook\.com$|protection\.outlook\.com$/i, name: "Microsoft 365" },
  { match: /mail\.protonmail\.ch$/i, name: "Proton Mail" },
  { match: /icloud\.com$|mail\.me\.com$/i, name: "iCloud Mail" },
  { match: /mailgun\.org$/i, name: "Mailgun" },
  { match: /sendgrid\.net$/i, name: "SendGrid" },
  { match: /amazonses\.com$|amazonaws\.com$/i, name: "Amazon SES" },
  { match: /zoho\.com$|zohomail\.com$/i, name: "Zoho Mail" },
  { match: /fastmail\.com$/i, name: "Fastmail" },
];

interface DkimResult {
  selector: string;
  found: boolean;
  record?: string;
}

interface CheckResult {
  domain: string;
  mx: {
    found: boolean;
    records: { exchange: string; priority: number }[];
    provider: string | null;
  };
  spf: {
    found: boolean;
    record: string | null;
    issues: string[];
    status: "ok" | "warn" | "fail" | "missing";
  };
  dkim: {
    selectorsChecked: number;
    found: DkimResult[];
    status: "ok" | "warn" | "missing";
  };
  dmarc: {
    found: boolean;
    record: string | null;
    policy: string | null;
    hasReporting: boolean;
    issues: string[];
    status: "ok" | "warn" | "fail" | "missing";
  };
  summary: { score: number; verdict: string };
}

function isValidDomain(s: string): boolean {
  // Permissive: letters, digits, dots, hyphens. 2+ labels, each 1-63 chars.
  // Rejects obvious abuse (no IPs, no schemes, no paths).
  if (s.length > 253) return false;
  const re = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
  return re.test(s);
}

async function lookupTxt(host: string): Promise<string[][] | null> {
  try {
    return await dns.resolveTxt(host);
  } catch {
    return null;
  }
}

async function lookupMx(domain: string): Promise<{ exchange: string; priority: number }[] | null> {
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority);
  } catch {
    return null;
  }
}

function findSpf(txtRecords: string[][] | null): string | null {
  if (!txtRecords) return null;
  // SPF records may be split across multiple strings in a single TXT record.
  // Join the strings within each record, then find one starting with v=spf1.
  for (const parts of txtRecords) {
    const joined = parts.join("");
    if (/^v=spf1\b/i.test(joined)) return joined;
  }
  return null;
}

function analyzeSpf(record: string | null): {
  issues: string[];
  status: "ok" | "warn" | "fail" | "missing";
} {
  if (!record) {
    return {
      issues: [
        "No SPF record found. Mail from your domain has no sender-policy validation, which makes it easier to spoof.",
      ],
      status: "missing",
    };
  }
  const issues: string[] = [];
  let status: "ok" | "warn" | "fail" = "ok";

  if (/\+all\b/i.test(record)) {
    issues.push(
      "Uses '+all' — allows any sender to claim to be your domain. This is the most dangerous SPF misconfiguration.",
    );
    status = "fail";
  } else if (/\?all\b/i.test(record)) {
    issues.push(
      "Ends with '?all' — neutral policy, neither asserts nor denies senders. Recommend '~all' or '-all'.",
    );
    if (status === "ok") status = "warn";
  } else if (!/~all\b|-all\b/i.test(record)) {
    issues.push(
      "No 'all' qualifier found at end of record. Recommend ending with '~all' (softfail) or '-all' (hardfail).",
    );
    if (status === "ok") status = "warn";
  }

  // Count DNS lookups (each include:, a:, mx:, redirect=, exists: counts as 1).
  // SPF caps at 10 lookups; over that, validators return permerror.
  const lookupTerms = (
    record.match(/\b(include:|a[:\s]|mx[:\s]|redirect=|exists:|ptr[:\s])/gi) ?? []
  ).length;
  if (lookupTerms > 10) {
    issues.push(
      `Contains ${lookupTerms} DNS lookups. SPF spec limits this to 10 — over the limit triggers a permerror and breaks validation.`,
    );
    status = "fail";
  } else if (lookupTerms >= 8) {
    issues.push(
      `Contains ${lookupTerms} DNS lookups. Approaching the 10-lookup SPF limit. Consider consolidating includes.`,
    );
    if (status === "ok") status = "warn";
  }

  return { issues, status };
}

function findDmarc(txtRecords: string[][] | null): string | null {
  if (!txtRecords) return null;
  for (const parts of txtRecords) {
    const joined = parts.join("");
    if (/^v=DMARC1\b/i.test(joined)) return joined;
  }
  return null;
}

function analyzeDmarc(record: string | null): {
  policy: string | null;
  hasReporting: boolean;
  issues: string[];
  status: "ok" | "warn" | "fail" | "missing";
} {
  if (!record) {
    return {
      policy: null,
      hasReporting: false,
      issues: [
        "No DMARC record found. Even with SPF and DKIM in place, receivers don't know what to do when a message fails. Spoofing protection is incomplete without DMARC.",
      ],
      status: "missing",
    };
  }
  const issues: string[] = [];
  let status: "ok" | "warn" | "fail" = "ok";

  const policyMatch = record.match(/\bp\s*=\s*(none|quarantine|reject)/i);
  const policy = policyMatch?.[1]?.toLowerCase() ?? null;

  if (policy === "none") {
    issues.push(
      "Policy is 'p=none' — reports only, no enforcement. Receivers will not block spoofed mail. Good for initial monitoring; move to 'quarantine' or 'reject' once SPF/DKIM align cleanly.",
    );
    if (status === "ok") status = "warn";
  } else if (!policy) {
    issues.push("No policy ('p=') tag found. DMARC requires a policy.");
    status = "fail";
  }

  const hasRua = /\brua\s*=\s*mailto:/i.test(record);
  const hasRuf = /\bruf\s*=\s*mailto:/i.test(record);

  if (!hasRua) {
    issues.push(
      "No 'rua' reporting address. You're flying blind on which senders are using your domain. Add 'rua=mailto:dmarc-reports@yourdomain.com' to receive aggregate reports.",
    );
    if (status === "ok") status = "warn";
  }

  return { policy, hasReporting: hasRua || hasRuf, issues, status };
}

function identifyProvider(mxRecords: { exchange: string }[]): string | null {
  for (const mx of mxRecords) {
    for (const p of MX_PROVIDERS) {
      if (p.match.test(mx.exchange)) return p.name;
    }
  }
  return null;
}

function computeSummary(result: Omit<CheckResult, "summary">): { score: number; verdict: string } {
  // Simple 0-100 score. Weighted: SPF 30, DKIM 20, DMARC 50 (DMARC is the
  // strongest signal since it requires SPF/DKIM alignment to work properly).
  let score = 0;

  if (result.spf.status === "ok") score += 30;
  else if (result.spf.status === "warn") score += 15;
  else if (result.spf.status === "fail") score += 5;

  if (result.dkim.status === "ok") score += 20;
  else if (result.dkim.status === "warn") score += 10;

  if (result.dmarc.status === "ok") score += 50;
  else if (result.dmarc.status === "warn") score += 25;
  else if (result.dmarc.status === "fail") score += 10;

  let verdict: string;
  if (score >= 90) verdict = "Strong. Email authentication is properly configured.";
  else if (score >= 60)
    verdict =
      "Functional but improvable. Some real gaps that affect deliverability or spoofing protection.";
  else if (score >= 30)
    verdict =
      "Significant gaps. Your domain is more spoofable than it should be, and major mail providers may filter you.";
  else
    verdict = "Largely unprotected. Email auth is mostly absent — your domain is highly spoofable.";

  return { score, verdict };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Akritos-only tool: gated behind the dmarcTools feature flag. Other tenants
  // get a 404 so the endpoint is indistinguishable from a non-existent route.
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "dmarcTools")) {
    return res.status(404).json({ error: "Not found" });
  }

  const body = (req.body ?? {}) as { domain?: string };
  const rawInput = body.domain ?? "";
  // Hard length cap BEFORE any regex work — prevents polynomial-ReDoS on
  // pathological input. Real domains max out at 253 chars per RFC 1035;
  // we accept a little slack for the http:// / www. prefixes a user might paste.
  if (typeof rawInput !== "string" || rawInput.length > 270) {
    return res.status(400).json({
      error: "That doesn't look like a valid domain. Enter something like 'yourbusiness.com'.",
    });
  }
  const raw = rawInput.trim().toLowerCase();
  // Strip common prefixes a user might paste in.
  const domain = raw
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");

  if (!isValidDomain(domain)) {
    return res.status(400).json({
      error: "That doesn't look like a valid domain. Enter something like 'yourbusiness.com'.",
    });
  }

  // Run all DNS lookups in parallel for speed.
  const [rootTxt, dmarcTxt, mxRecords, ...dkimResults] = await Promise.all([
    lookupTxt(domain),
    lookupTxt(`_dmarc.${domain}`),
    lookupMx(domain),
    ...DKIM_SELECTORS.map((selector) =>
      lookupTxt(`${selector}._domainkey.${domain}`).then((txt) => ({
        selector,
        found: !!txt && txt.length > 0,
        record: txt?.[0]?.join("") ?? undefined,
      })),
    ),
  ]);

  const spfRecord = findSpf(rootTxt);
  const spf = { record: spfRecord, ...analyzeSpf(spfRecord) };

  const dmarcRecord = findDmarc(dmarcTxt);
  const dmarcAnalysis = analyzeDmarc(dmarcRecord);

  const dkimFound = (dkimResults as DkimResult[]).filter((r) => r.found);
  const dkimStatus: "ok" | "warn" | "missing" = dkimFound.length >= 1 ? "ok" : "missing";

  const result: Omit<CheckResult, "summary"> = {
    domain,
    mx: {
      found: !!mxRecords && mxRecords.length > 0,
      records: mxRecords ?? [],
      provider: mxRecords ? identifyProvider(mxRecords) : null,
    },
    spf: {
      found: !!spfRecord,
      record: spfRecord,
      issues: spf.issues,
      status: spf.status,
    },
    dkim: {
      selectorsChecked: DKIM_SELECTORS.length,
      found: dkimFound,
      status: dkimStatus,
    },
    dmarc: {
      found: !!dmarcRecord,
      record: dmarcRecord,
      policy: dmarcAnalysis.policy,
      hasReporting: dmarcAnalysis.hasReporting,
      issues: dmarcAnalysis.issues,
      status: dmarcAnalysis.status,
    },
  };

  const summary = computeSummary(result);

  return res.status(200).json({ ...result, summary } satisfies CheckResult);
}

// 20 checks / 10 min per client IP — plenty for a real user, curbs casual abuse
// of the DNS-probing endpoint. (Holt's limiter keys on the socket IP, honoring
// TRUST_PROXY, rather than the spoofable X-Forwarded-For the upstream version used.)
export default rateLimit({ windowMs: 10 * 60 * 1000, maxRequests: 20 })(handler);
