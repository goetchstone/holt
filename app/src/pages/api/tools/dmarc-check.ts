// /app/src/pages/api/tools/dmarc-check.ts
// Server-side DNS lookups for SPF / DKIM / DMARC / MX / MTA-STS / TLS-RPT /
// BIMI records on a given domain. Public endpoint, rate-limited per IP.
// Returns parsed records + plain-English issues + paste-ready suggested DNS
// records. Used by the /tools/dmarc-check landing page. Analysis logic lives
// in @/lib/dmarc/check so it can be unit-tested without live DNS.

import type { NextApiRequest, NextApiResponse } from "next";
import { promises as dns } from "node:dns";
import { rateLimit } from "@/lib/rateLimit";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import {
  classifyDnsError,
  isDkimKeyRecord,
  findDmarcRecords,
  analyzeDmarc,
  analyzeMtaSts,
  analyzeTlsRpt,
  analyzeBimi,
  suggestedRecords,
  findSpf,
  analyzeSpf,
  identifyProvider,
  isValidDomain,
  computeSummary,
  DKIM_SELECTORS,
  type DkimResult,
  type MxRecord,
  type CheckResult,
} from "@/lib/dmarc/check";

// DKIM selector probes are best-effort and never fail the whole request. This
// caps how many run concurrently — see the batching loop below for why.
const DKIM_PROBE_CONCURRENCY = 8;

// Resolve a TXT lookup, distinguishing "no such record" (return null) from a
// transient resolver failure (throw) so a SERVFAIL/timeout never masquerades
// as a missing record and falsely tanks the score.
async function lookupTxt(host: string): Promise<string[][] | null> {
  try {
    return await dns.resolveTxt(host);
  } catch (err) {
    if (classifyDnsError(err) === "transient") throw err;
    return null;
  }
}

async function lookupMx(domain: string): Promise<MxRecord[] | null> {
  try {
    return (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
  } catch (err) {
    if (classifyDnsError(err) === "transient") throw err;
    return null;
  }
}

// DKIM selector probe — best-effort. A non-existent selector (the common
// case) or any resolver hiccup is simply "not found"; a present TXT counts
// only when it's actually a DKIM key, not a stray record sitting at the
// probed name.
async function probeDkim(selector: string, domain: string): Promise<DkimResult> {
  try {
    const txt = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
    const record = txt.map((parts) => parts.join("")).find(isDkimKeyRecord);
    return { selector, found: !!record, record };
  } catch {
    return { selector, found: false };
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Akritos-only tool: gated behind the dmarcTools feature flag. Other
  // tenants get a 404 so the endpoint is indistinguishable from a
  // non-existent route.
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "dmarcTools")) {
    return res.status(404).json({ error: "Not found" });
  }

  const body = (req.body ?? {}) as { domain?: string };
  const rawInput = body.domain ?? "";
  // Hard length cap BEFORE any regex work — prevents polynomial-ReDoS on
  // pathological input. Real domains max out at 253 chars per RFC 1035; we
  // accept a little slack for the http:// / www. prefixes a user might paste.
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

  // Core records first: a transient resolver failure here must surface as an
  // error, not as a false "everything is missing" verdict.
  let rootTxt: string[][] | null;
  let dmarcTxt: string[][] | null;
  let mxRecords: MxRecord[] | null;
  let mtaStsTxt: string[][] | null;
  let tlsRptTxt: string[][] | null;
  let bimiTxt: string[][] | null;
  try {
    [rootTxt, dmarcTxt, mxRecords, mtaStsTxt, tlsRptTxt, bimiTxt] = await Promise.all([
      lookupTxt(domain),
      lookupTxt(`_dmarc.${domain}`),
      lookupMx(domain),
      lookupTxt(`_mta-sts.${domain}`),
      lookupTxt(`_smtp._tls.${domain}`),
      lookupTxt(`default._bimi.${domain}`),
    ]);
  } catch {
    return res.status(503).json({
      error: "Couldn't complete the DNS lookup right now. Please try again in a moment.",
    });
  }

  // DKIM selector probes are best-effort and never fail the whole request.
  // Bounded concurrency so one HTTP request can't fan out into ~45
  // simultaneous DNS queries — amplification against the probed domain and
  // pressure on our own resolver / file descriptors.
  const dkimResults: DkimResult[] = [];
  for (let i = 0; i < DKIM_SELECTORS.length; i += DKIM_PROBE_CONCURRENCY) {
    const batch = DKIM_SELECTORS.slice(i, i + DKIM_PROBE_CONCURRENCY);
    dkimResults.push(...(await Promise.all(batch.map((s) => probeDkim(s, domain)))));
  }

  const spfRecord = findSpf(rootTxt);
  const spf = { record: spfRecord, ...analyzeSpf(spfRecord) };

  const dmarc = analyzeDmarc(findDmarcRecords(dmarcTxt));
  const mtaSts = analyzeMtaSts(mtaStsTxt);
  const tlsRpt = analyzeTlsRpt(tlsRptTxt);
  const bimi = analyzeBimi(bimiTxt);

  const dkimFound = dkimResults.filter((r) => r.found);
  const provider = mxRecords ? identifyProvider(mxRecords) : null;

  const result: Omit<CheckResult, "summary"> = {
    domain,
    mx: {
      found: !!mxRecords && mxRecords.length > 0,
      records: mxRecords ?? [],
      provider,
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
      status: dkimFound.length >= 1 ? "ok" : "missing",
    },
    dmarc: {
      found: !!dmarc.record,
      record: dmarc.record,
      policy: dmarc.policy,
      subdomainPolicy: dmarc.subdomainPolicy,
      pct: dmarc.pct,
      enforcing: dmarc.enforcing,
      hasReporting: dmarc.hasReporting,
      issues: dmarc.issues,
      status: dmarc.status,
    },
    mtaSts,
    tlsRpt,
    bimi,
    fixes: suggestedRecords({
      domain,
      provider,
      spfRecord,
      spfStatus: spf.status,
      dmarc,
      mtaSts,
      tlsRpt,
    }),
  };

  const summary = computeSummary(result);

  return res.status(200).json({ ...result, summary } satisfies CheckResult);
}

// 20 checks / 10 min per client IP — plenty for a real user, curbs casual
// abuse of the DNS-probing endpoint. (Holt's limiter keys on the socket IP,
// honoring TRUST_PROXY, rather than the spoofable X-Forwarded-For the
// upstream version used.)
export default rateLimit({ windowMs: 10 * 60 * 1000, maxRequests: 20 })(handler);
