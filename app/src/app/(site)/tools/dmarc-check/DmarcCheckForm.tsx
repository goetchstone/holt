// /app/src/app/(site)/tools/dmarc-check/DmarcCheckForm.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Loader2,
} from "lucide-react";

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

type Status = "ok" | "warn" | "fail" | "missing";

function StatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
    case "warn":
      return <AlertTriangle className="h-5 w-5 text-amber-400" />;
    case "fail":
      return <XCircle className="h-5 w-5 text-rose-400" />;
    case "missing":
      return <HelpCircle className="h-5 w-5 text-bone/40" />;
  }
}

function statusLabel(status: Status): string {
  switch (status) {
    case "ok":
      return "OK";
    case "warn":
      return "Needs attention";
    case "fail":
      return "Misconfigured";
    case "missing":
      return "Not found";
  }
}

export function DmarcCheckForm() {
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/tools/dmarc-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Lookup failed");
      } else {
        setResult(data as CheckResult);
      }
    } catch {
      setError("Network error. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          required
          placeholder="yourbusiness.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          maxLength={253}
          autoComplete="off"
          className="flex-1 border border-bone/20 bg-midnight px-4 py-3 text-base text-bone placeholder-bone/30 focus:border-conviction focus:outline-none"
          style={{ borderRadius: "2px" }}
        />
        <button
          type="submit"
          disabled={loading || !domain}
          className="inline-flex items-center justify-center gap-2 bg-conviction px-6 py-3 text-sm font-medium text-midnight transition-colors hover:bg-conviction/90 disabled:opacity-50"
          style={{ borderRadius: "2px" }}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Checking…
            </>
          ) : (
            <>
              Check domain <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </form>

      {error && (
        <div
          className="border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200"
          style={{ borderRadius: "2px" }}
        >
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          {/* Summary score */}
          <div
            className="border border-conviction/30 bg-slate-brand/20 p-6"
            style={{ borderRadius: "2px" }}
          >
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.15em] text-conviction">
                  Score for {result.domain}
                </p>
                <p className="mt-2 text-base leading-relaxed text-bone/80">
                  {result.summary.verdict}
                </p>
              </div>
              <div className="text-right">
                <span className="text-4xl font-medium text-bone">{result.summary.score}</span>
                <span className="text-sm text-bone/40"> / 100</span>
              </div>
            </div>
          </div>

          {/* MX */}
          <ResultSection
            title="Mail Exchanger (MX)"
            status={result.mx.found ? "ok" : "missing"}
            statusLabelOverride={
              result.mx.found
                ? `${result.mx.records.length} record${result.mx.records.length === 1 ? "" : "s"}`
                : "Not found"
            }
            description={
              result.mx.provider
                ? `Mail for ${result.domain} is handled by ${result.mx.provider}.`
                : result.mx.found
                  ? `Mail for ${result.domain} is handled by ${result.mx.records[0]?.exchange}.`
                  : "No MX records — this domain does not receive email."
            }
          >
            {result.mx.records.length > 0 && (
              <ul className="space-y-1 text-sm text-bone/60">
                {result.mx.records.map((m) => (
                  <li key={m.exchange} className="font-mono">
                    {m.priority} {m.exchange}
                  </li>
                ))}
              </ul>
            )}
          </ResultSection>

          {/* SPF */}
          <ResultSection
            title="SPF (Sender Policy Framework)"
            status={result.spf.status}
            description={
              result.spf.found
                ? "Defines which servers are allowed to send mail claiming to be from your domain."
                : "Without SPF, any server can claim to be sending mail from your domain."
            }
          >
            {result.spf.record && (
              <div
                className="mb-3 break-all border border-bone/10 bg-midnight p-3 font-mono text-xs text-bone/70"
                style={{ borderRadius: "2px" }}
              >
                {result.spf.record}
              </div>
            )}
            {result.spf.issues.length > 0 && <IssueList items={result.spf.issues} />}
          </ResultSection>

          {/* DKIM */}
          <ResultSection
            title="DKIM (DomainKeys Identified Mail)"
            status={result.dkim.status}
            statusLabelOverride={
              result.dkim.found.length > 0
                ? `${result.dkim.found.length} selector${result.dkim.found.length === 1 ? "" : "s"} found`
                : `None found in ${result.dkim.selectorsChecked} common selectors`
            }
            description={
              result.dkim.found.length > 0
                ? "Cryptographically signs your outgoing mail so receivers can verify it wasn't tampered with."
                : "We checked the selectors the major providers use. DKIM might still be set up correctly under a custom selector name we can't guess — DKIM selectors can't be looked up automatically. If your mail is sending fine and passing DMARC, you likely have it. A DMARC report (or your email provider) will tell you the exact selector."
            }
          >
            {result.dkim.found.length > 0 ? (
              <ul className="space-y-1 text-sm text-bone/60">
                {result.dkim.found.map((d) => (
                  <li key={d.selector}>
                    <span className="font-mono text-conviction">{d.selector}</span>
                    <span className="text-bone/30"> · _domainkey.{result.domain}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-bone/40">
                Probed: {result.dkim.selectorsChecked} known provider selectors (Google, Microsoft
                365, DreamHost, Mailchimp, SendGrid, Proton, Zoho, Fastmail, etc.)
              </p>
            )}
          </ResultSection>

          {/* DMARC */}
          <ResultSection
            title="DMARC (Domain-based Message Authentication, Reporting & Conformance)"
            status={result.dmarc.status}
            statusLabelOverride={
              result.dmarc.found ? `Policy: ${result.dmarc.policy ?? "unset"}` : "Not found"
            }
            description={
              result.dmarc.found
                ? "Tells receivers what to do with mail that fails SPF or DKIM checks, and where to send reports."
                : "Without DMARC, receivers don't know how strictly to enforce your sender policies. Spoofers can still get through to inboxes."
            }
          >
            {result.dmarc.record && (
              <div
                className="mb-3 break-all border border-bone/10 bg-midnight p-3 font-mono text-xs text-bone/70"
                style={{ borderRadius: "2px" }}
              >
                {result.dmarc.record}
              </div>
            )}
            {result.dmarc.issues.length > 0 && <IssueList items={result.dmarc.issues} />}
          </ResultSection>

          {/* CTA */}
          <div
            className="border border-conviction/30 bg-slate-brand/30 p-6"
            style={{ borderRadius: "2px" }}
          >
            <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-conviction">
              Want help fixing this?
            </p>
            <h3 className="text-lg font-medium text-bone">Email Authentication Setup</h3>
            <p className="mt-3 text-base leading-relaxed text-bone/70">
              We&apos;ll set up SPF, DKIM, and DMARC correctly for your domain — with a reporting
              address so you can see who&apos;s sending mail in your name. Includes testing across
              major providers, a 30-day monitoring period in &lsquo;p=none&rsquo; before tightening,
              and documentation you own.
            </p>
            <p className="mt-3 text-base text-bone/70">
              Flat-fee project work. Quoted after your free hour, no surprise invoices.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <Link
                href="/book"
                className="inline-flex items-center gap-2 bg-conviction px-6 py-3 text-sm font-medium text-midnight transition-colors hover:bg-conviction/90"
                style={{ borderRadius: "2px" }}
              >
                Book your free hour <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/services"
                className="inline-flex items-center gap-2 border border-bone/20 px-6 py-3 text-sm font-medium text-bone transition-colors hover:border-conviction hover:text-conviction"
                style={{ borderRadius: "2px" }}
              >
                See all services
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultSection({
  title,
  status,
  description,
  statusLabelOverride,
  children,
}: {
  title: string;
  status: Status;
  description: string;
  statusLabelOverride?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="border border-bone/10 bg-midnight p-5" style={{ borderRadius: "2px" }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <StatusIcon status={status} />
          <div>
            <h3 className="text-base font-medium text-bone">{title}</h3>
            <p className="mt-1 text-sm text-bone/40">
              {statusLabelOverride ?? statusLabel(status)}
            </p>
          </div>
        </div>
      </div>
      <p className="mb-3 text-sm leading-relaxed text-bone/60">{description}</p>
      {children}
    </div>
  );
}

function IssueList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-bone/60">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
