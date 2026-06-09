// /app/src/lib/dmarc/report.ts
// Pure, environment-agnostic parser + aggregator for DMARC aggregate (RUA)
// reports. No browser or Node APIs — takes an XML string, returns typed data,
// so it runs identically in the browser and in vitest (node).
//
// Security posture (see the threat model behind this feature):
//  - Parsed with @rgrove/parse-xml, which rejects DTDs and resolves NO external
//    entities by default → immune to XXE and billion-laughs by construction.
//  - Defense-in-depth pre-parse guard rejects any DOCTYPE/ENTITY before parsing.
//  - Extraction reads a FIXED ALLOWLIST of named elements only; attacker-
//    controlled element names are never reflected into object keys → no
//    prototype pollution.
//  - Hard caps on input length and record count; every numeric field clamped.
//  - Callers render values via React (auto-escaped); this module never builds
//    HTML/URLs.

import { parseXml, XmlElement } from "@rgrove/parse-xml";

// Real DMARC reports are KB to low-MB of XML. 30 MB is generous headroom and
// still bounds worst-case parse cost. The decompression layer caps earlier too.
const MAX_XML_CHARS = 30_000_000;
// A single report with more rows than this is either pathological or a DoS
// attempt; we stop and flag truncation rather than process unbounded.
const MAX_RECORDS = 5000;
const MAX_COUNT = 1_000_000_000;
// A legitimate record has a handful of auth_results entries; cap to keep a
// crafted record from inflating memory / the selector list unbounded.
const MAX_AUTH_PER_RECORD = 100;

export type Disposition = "none" | "quarantine" | "reject" | "unknown";
export type AuthEval = "pass" | "fail" | "unknown";

export interface DmarcAuthDkim {
  domain?: string;
  selector?: string;
  result?: string;
}

export interface DmarcAuthSpf {
  domain?: string;
  scope?: string;
  result?: string;
}

export interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: Disposition;
  evalDkim: AuthEval;
  evalSpf: AuthEval;
  reasons: { type?: string; comment?: string }[];
  headerFrom?: string;
  envelopeFrom?: string;
  envelopeTo?: string;
  authDkim: DmarcAuthDkim[];
  authSpf: DmarcAuthSpf[];
}

export interface DmarcPolicy {
  domain?: string;
  adkim?: string;
  aspf?: string;
  p?: string;
  sp?: string;
  np?: string;
  pct?: string;
  fo?: string;
}

export interface DmarcReport {
  orgName?: string;
  email?: string;
  reportId?: string;
  extraContactInfo?: string;
  dateBegin?: number;
  dateEnd?: number;
  policy: DmarcPolicy;
  records: DmarcRecord[];
  recordsTruncated: boolean;
}

// ── XML tree helpers (named lookups only — never positional, never reflective) ──

function elementChildren(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (child instanceof XmlElement) out.push(child);
  }
  return out;
}

function childEls(parent: XmlElement, name: string): XmlElement[] {
  const lower = name.toLowerCase();
  return elementChildren(parent).filter((c) => c.name.toLowerCase() === lower);
}

function childEl(parent: XmlElement, name: string): XmlElement | undefined {
  return childEls(parent, name)[0];
}

// Trimmed text content of a named child, or undefined if absent/empty.
function childText(parent: XmlElement, name: string): string | undefined {
  const el = childEl(parent, name);
  if (!el) return undefined;
  const t = el.text.trim();
  return t.length ? t : undefined;
}

function clampCount(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > MAX_COUNT ? MAX_COUNT : n;
}

function toDisposition(raw: string | undefined): Disposition {
  switch ((raw ?? "").toLowerCase()) {
    case "none":
      return "none";
    case "quarantine":
      return "quarantine";
    case "reject":
      return "reject";
    default:
      return "unknown";
  }
}

function toAuthEval(raw: string | undefined): AuthEval {
  const v = (raw ?? "").toLowerCase();
  if (v === "pass") return "pass";
  if (v === "fail") return "fail";
  return "unknown";
}

function parseEpoch(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ── Record extraction ──────────────────────────────────────────────────────

function parseRecord(recordEl: XmlElement): DmarcRecord {
  const row = childEl(recordEl, "row");
  const policyEvaluated = row ? childEl(row, "policy_evaluated") : undefined;
  const identifiers = childEl(recordEl, "identifiers");
  const authResults = childEl(recordEl, "auth_results");

  const reasons: { type?: string; comment?: string }[] = [];
  if (policyEvaluated) {
    for (const reasonEl of childEls(policyEvaluated, "reason")) {
      reasons.push({
        type: childText(reasonEl, "type"),
        comment: childText(reasonEl, "comment"),
      });
    }
  }

  const authDkim: DmarcAuthDkim[] = [];
  const authSpf: DmarcAuthSpf[] = [];
  if (authResults) {
    for (const d of childEls(authResults, "dkim").slice(0, MAX_AUTH_PER_RECORD)) {
      authDkim.push({
        domain: childText(d, "domain"),
        selector: childText(d, "selector"),
        result: childText(d, "result"),
      });
    }
    for (const s of childEls(authResults, "spf").slice(0, MAX_AUTH_PER_RECORD)) {
      authSpf.push({
        domain: childText(s, "domain"),
        scope: childText(s, "scope"),
        result: childText(s, "result"),
      });
    }
  }

  return {
    sourceIp: (row && childText(row, "source_ip")) || "unknown",
    count: clampCount(row && childText(row, "count")),
    disposition: toDisposition(policyEvaluated && childText(policyEvaluated, "disposition")),
    evalDkim: toAuthEval(policyEvaluated && childText(policyEvaluated, "dkim")),
    evalSpf: toAuthEval(policyEvaluated && childText(policyEvaluated, "spf")),
    reasons,
    headerFrom: identifiers && childText(identifiers, "header_from"),
    envelopeFrom: identifiers && childText(identifiers, "envelope_from"),
    envelopeTo: identifiers && childText(identifiers, "envelope_to"),
    authDkim,
    authSpf,
  };
}

export class DmarcParseError extends Error {}

/**
 * Parse a DMARC aggregate report XML string into typed data.
 * Throws DmarcParseError with a user-facing message on anything that isn't a
 * well-formed DMARC aggregate report.
 */
export function parseDmarcReport(xml: string): DmarcReport {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new DmarcParseError("Empty file — nothing to read.");
  }
  if (xml.length > MAX_XML_CHARS) {
    throw new DmarcParseError("That report is too large to process safely.");
  }
  // Defense-in-depth: reject DTDs/entities before the parser sees them. Real
  // DMARC reports never contain these; their only use here would be an attack.
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new DmarcParseError("This file contains a document-type declaration and was rejected.");
  }

  let doc;
  try {
    // Default options only — DTDs rejected, no external entity resolution.
    doc = parseXml(xml);
  } catch {
    throw new DmarcParseError("That doesn't look like a valid XML file.");
  }

  const root = doc.root;
  if (!root || root.name.toLowerCase() !== "feedback") {
    throw new DmarcParseError("This doesn't look like a DMARC aggregate report.");
  }

  const metadata = childEl(root, "report_metadata");
  const policyPublished = childEl(root, "policy_published");
  const recordEls = childEls(root, "record");

  if (!metadata || !policyPublished || recordEls.length === 0) {
    throw new DmarcParseError("This doesn't look like a DMARC aggregate report.");
  }

  const dateRange = childEl(metadata, "date_range");

  const policy: DmarcPolicy = {
    domain: childText(policyPublished, "domain"),
    adkim: childText(policyPublished, "adkim"),
    aspf: childText(policyPublished, "aspf"),
    p: childText(policyPublished, "p"),
    sp: childText(policyPublished, "sp"),
    np: childText(policyPublished, "np"),
    pct: childText(policyPublished, "pct"),
    fo: childText(policyPublished, "fo"),
  };

  const recordsTruncated = recordEls.length > MAX_RECORDS;
  const records = (recordsTruncated ? recordEls.slice(0, MAX_RECORDS) : recordEls).map(parseRecord);

  return {
    orgName: childText(metadata, "org_name"),
    email: childText(metadata, "email"),
    reportId: childText(metadata, "report_id"),
    extraContactInfo: childText(metadata, "extra_contact_info"),
    dateBegin: dateRange ? parseEpoch(childText(dateRange, "begin")) : undefined,
    dateEnd: dateRange ? parseEpoch(childText(dateRange, "end")) : undefined,
    policy,
    records,
    recordsTruncated,
  };
}

// ── Aggregation across one or more reports ──────────────────────────────────

export interface SourceSummary {
  sourceIp: string;
  total: number;
  dmarcPass: number;
  dmarcFail: number;
  delivered: number;
  quarantined: number;
  rejected: number;
  // Distinct DKIM signing domains / selectors seen from this source — useful
  // for recognizing a legitimate third-party sender (and for the checker).
  authDomains: string[];
  selectors: string[];
}

export interface DmarcSummary {
  reporters: string[];
  policyDomain?: string;
  publishedPolicy?: string;
  publishedPct?: string;
  // Policy-override reasons (forwarded, mailing_list, local_policy, …) weighted
  // by message count — a failing-but-delivered source is often a forwarder, not
  // an attacker, so surfacing these prevents false alarm.
  overrideReasons: { type: string; count: number }[];
  dateBegin?: number;
  dateEnd?: number;
  totalMessages: number;
  dmarcPass: number;
  dmarcFail: number;
  dkimAlignedPass: number;
  spfAlignedPass: number;
  delivered: number;
  quarantined: number;
  rejected: number;
  sources: SourceSummary[];
  failingSources: SourceSummary[];
  selectorsSeen: string[];
}

// DMARC passes when at least one *aligned* mechanism passes. The
// policy_evaluated dkim/spf values are exactly those aligned results, so a
// message is DMARC-passing iff evalDkim==pass OR evalSpf==pass.
function recordPassesDmarc(r: DmarcRecord): boolean {
  return r.evalDkim === "pass" || r.evalSpf === "pass";
}

export function summarizeReports(reports: DmarcReport[]): DmarcSummary {
  const reporters = new Set<string>();
  const sourceMap = new Map<string, SourceSummary>();
  const selectorsSeen = new Set<string>();
  const reasonCounts = new Map<string, number>();

  let totalMessages = 0;
  let dmarcPass = 0;
  let dmarcFail = 0;
  let dkimAlignedPass = 0;
  let spfAlignedPass = 0;
  let delivered = 0;
  let quarantined = 0;
  let rejected = 0;
  let dateBegin: number | undefined;
  let dateEnd: number | undefined;
  let policyDomain: string | undefined;
  let publishedPolicy: string | undefined;
  let publishedPct: string | undefined;

  for (const report of reports) {
    if (report.orgName) reporters.add(report.orgName);
    if (report.policy.domain && !policyDomain) policyDomain = report.policy.domain;
    if (report.policy.p && !publishedPolicy) publishedPolicy = report.policy.p;
    if (report.policy.pct && !publishedPct) publishedPct = report.policy.pct;
    if (report.dateBegin !== undefined) {
      dateBegin =
        dateBegin === undefined ? report.dateBegin : Math.min(dateBegin, report.dateBegin);
    }
    if (report.dateEnd !== undefined) {
      dateEnd = dateEnd === undefined ? report.dateEnd : Math.max(dateEnd, report.dateEnd);
    }

    for (const r of report.records) {
      const c = r.count;
      totalMessages += c;

      const passes = recordPassesDmarc(r);
      if (passes) dmarcPass += c;
      else dmarcFail += c;
      if (r.evalDkim === "pass") dkimAlignedPass += c;
      if (r.evalSpf === "pass") spfAlignedPass += c;

      if (r.disposition === "reject") rejected += c;
      else if (r.disposition === "quarantine") quarantined += c;
      else delivered += c;

      // Use a Map (no prototype) keyed by source IP; values are typed structs.
      let src = sourceMap.get(r.sourceIp);
      if (!src) {
        src = {
          sourceIp: r.sourceIp,
          total: 0,
          dmarcPass: 0,
          dmarcFail: 0,
          delivered: 0,
          quarantined: 0,
          rejected: 0,
          authDomains: [],
          selectors: [],
        };
        sourceMap.set(r.sourceIp, src);
      }
      src.total += c;
      if (passes) src.dmarcPass += c;
      else src.dmarcFail += c;
      if (r.disposition === "reject") src.rejected += c;
      else if (r.disposition === "quarantine") src.quarantined += c;
      else src.delivered += c;

      for (const d of r.authDkim) {
        if (d.selector) {
          selectorsSeen.add(d.selector);
          if (!src.selectors.includes(d.selector)) src.selectors.push(d.selector);
        }
        if (d.domain && !src.authDomains.includes(d.domain)) src.authDomains.push(d.domain);
      }

      for (const reason of r.reasons) {
        if (reason.type) {
          reasonCounts.set(reason.type, (reasonCounts.get(reason.type) ?? 0) + c);
        }
      }
    }
  }

  const sources = [...sourceMap.values()].sort((a, b) => b.total - a.total);
  const failingSources = sources
    .filter((s) => s.quarantined > 0 || s.rejected > 0 || s.dmarcFail > 0)
    .sort(
      (a, b) =>
        b.quarantined + b.rejected - (a.quarantined + a.rejected) || b.dmarcFail - a.dmarcFail,
    );

  return {
    reporters: [...reporters].sort(),
    policyDomain,
    publishedPolicy,
    publishedPct,
    overrideReasons: [...reasonCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    dateBegin,
    dateEnd,
    totalMessages,
    dmarcPass,
    dmarcFail,
    dkimAlignedPass,
    spfAlignedPass,
    delivered,
    quarantined,
    rejected,
    sources,
    failingSources,
    selectorsSeen: [...selectorsSeen].sort(),
  };
}
