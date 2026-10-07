// /app/src/app/(site)/tools/dmarc-report/DmarcReportForm.tsx
"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Upload,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import {
  parseDmarcReport,
  summarizeReports,
  type DmarcReport,
  type DmarcSummary,
} from "@/lib/dmarc/report";
import { decompressToXml } from "@/lib/dmarc/decompress";

interface FileError {
  name: string;
  message: string;
}

const MAX_BATCH = 200;
const MAX_SELECTORS_SHOWN = 100;

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function fmtEpoch(epoch?: number): string {
  if (epoch === undefined) return "";
  const d = new Date(epoch * 1000);
  return d.toISOString().slice(0, 10);
}

// Yield to the event loop so a large batch doesn't freeze the UI / spinner.
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export function DmarcReportForm() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<DmarcSummary | null>(null);
  const [reportCount, setReportCount] = useState(0);
  const [attempted, setAttempted] = useState(0);
  const [errors, setErrors] = useState<FileError[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [paste, setPaste] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const process = useCallback(async (inputs: { name: string; bytes: Uint8Array }[]) => {
    setBusy(true);
    setAttempted(inputs.length);
    setProgress({ done: 0, total: inputs.length });
    const reports: DmarcReport[] = [];
    const errs: FileError[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const { name, bytes } = inputs[i]!;
      try {
        const xml = await decompressToXml(bytes);
        reports.push(parseDmarcReport(xml));
      } catch (e) {
        errs.push({ name, message: e instanceof Error ? e.message : "Could not read this file." });
      }
      setProgress({ done: i + 1, total: inputs.length });
      if ((i + 1) % 10 === 0) await yieldToUi(); // keep the UI responsive
    }
    setReportCount(reports.length);
    setErrors(errs);
    setSummary(reports.length ? summarizeReports(reports) : null);
    setBusy(false);
  }, []);

  const onFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).slice(0, MAX_BATCH);
      const inputs = await Promise.all(
        files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      );
      await process(inputs);
    },
    [process],
  );

  const onPaste = useCallback(async () => {
    if (!paste.trim()) return;
    await process([{ name: "pasted XML", bytes: new TextEncoder().encode(paste) }]);
  }, [paste, process]);

  function reset() {
    setSummary(null);
    setErrors([]);
    setReportCount(0);
    setAttempted(0);
    setProgress({ done: 0, total: 0 });
    setPaste("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function openPicker() {
    inputRef.current?.click();
  }

  return (
    <div className="space-y-8">
      {/* Drop zone — a real, keyboard-operable button */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose DMARC report files to analyze"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void onFiles(e.dataTransfer.files);
        }}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        className={`flex cursor-pointer flex-col items-center justify-center border-2 border-dashed px-6 py-12 text-center transition-colors focus:outline-none focus-visible:border-conviction focus-visible:ring-1 focus-visible:ring-conviction ${
          dragOver
            ? "border-conviction bg-slate-brand/20"
            : "border-bone/20 hover:border-conviction/50"
        }`}
        style={{ borderRadius: "2px" }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xml,.gz,.zip,application/gzip,application/zip,text/xml"
          multiple
          className="hidden"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files?.length) void onFiles(e.target.files);
          }}
        />
        {busy ? (
          <Loader2 className="mb-3 h-8 w-8 animate-spin text-conviction" aria-hidden="true" />
        ) : (
          <Upload className="mb-3 h-8 w-8 text-conviction" strokeWidth={1.5} aria-hidden="true" />
        )}
        <p className="text-base font-medium text-bone">
          {busy ? "Reading your reports…" : "Drop DMARC report files here, or click to choose"}
        </p>
        <p className="mt-2 text-sm text-bone/50">
          .xml, .xml.gz, or .zip — drop the whole batch at once. Processed entirely in your browser.
        </p>
      </div>

      {/* Live status for assistive tech */}
      <div role="status" aria-live="polite" className="sr-only">
        {busy
          ? `Reading reports, ${progress.done} of ${progress.total} processed.`
          : summary
            ? `Analysis complete. ${reportCount} of ${attempted} files read.`
            : ""}
      </div>
      {busy && progress.total > 1 && (
        <p className="text-center text-sm text-bone/50">
          Reading {progress.done} of {progress.total}…
        </p>
      )}

      {/* Paste fallback */}
      <details className="group">
        <summary className="cursor-pointer text-sm text-bone/50 hover:text-conviction">
          Or paste report XML directly
        </summary>
        <div className="mt-3 space-y-3">
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            aria-label="Paste DMARC report XML"
            placeholder='<?xml version="1.0"?><feedback>…'
            className="w-full border border-bone/20 bg-midnight px-3 py-2 font-mono text-xs text-bone placeholder-bone/30 focus:border-conviction focus:outline-none"
            style={{ borderRadius: "2px" }}
          />
          <button
            type="button"
            onClick={() => void onPaste()}
            disabled={busy || !paste.trim()}
            className="inline-flex items-center gap-2 border border-bone/20 px-5 py-2 text-sm font-medium text-bone transition-colors hover:border-conviction hover:text-conviction disabled:opacity-50"
            style={{ borderRadius: "2px" }}
          >
            Analyze pasted XML <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </details>

      {/* Privacy reassurance */}
      <div className="flex items-start gap-2 text-xs text-bone/40">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-conviction/60" aria-hidden="true" />
        <span>
          Your reports never leave your browser. There&apos;s no upload — the parsing and analysis
          happen entirely on your device. Nothing is sent to us or stored anywhere.
        </span>
      </div>

      {/* Batch summary line (covers partial + total failure) */}
      {!busy && attempted > 0 && (
        <p className="text-sm text-bone/60">
          Analyzed <span className="text-bone">{reportCount}</span> of {attempted} file
          {attempted === 1 ? "" : "s"}
          {errors.length > 0 ? ` — ${errors.length} could not be read.` : "."}
        </p>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div role="alert" className="space-y-2">
          {errors.map((e, i) => (
            <div
              key={i}
              className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
              style={{ borderRadius: "2px" }}
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium">{e.name}</span> — {e.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Results */}
      {summary && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium text-bone">Results</h2>
            <button
              type="button"
              onClick={reset}
              className="text-sm text-bone/50 underline underline-offset-2 hover:text-conviction"
            >
              Analyze more
            </button>
          </div>

          <ResultsView summary={summary} reportCount={reportCount} />

          {/* CTA */}
          <div
            className="border border-conviction/30 bg-slate-brand/30 p-6"
            style={{ borderRadius: "2px" }}
          >
            <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-conviction">
              Want a hand reading these?
            </p>
            <h3 className="text-lg font-medium text-bone">
              We&apos;ll set up and monitor DMARC for you
            </h3>
            <p className="mt-3 text-base leading-relaxed text-bone/70">
              If the failing sources don&apos;t look familiar, or you&apos;re not sure whether
              it&apos;s safe to move from <code className="text-conviction">p=none</code> to
              enforcement, that&apos;s exactly the kind of thing we do. Free one-hour consultation —
              we&apos;ll read your reports with you and tell you what&apos;s legitimate and what
              isn&apos;t.
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
                href="/tools/dmarc-check"
                className="inline-flex items-center gap-2 border border-bone/20 px-6 py-3 text-sm font-medium text-bone transition-colors hover:border-conviction hover:text-conviction"
                style={{ borderRadius: "2px" }}
              >
                Check your DNS records
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultsView({ summary, reportCount }: { summary: DmarcSummary; reportCount: number }) {
  const passRate = pct(summary.dmarcPass, summary.totalMessages);

  return (
    <div className="space-y-6">
      {/* Headline */}
      <div className="border border-bone/10 bg-slate-brand/20 p-6" style={{ borderRadius: "2px" }}>
        <p className="text-xs font-medium uppercase tracking-[0.15em] text-conviction">
          {reportCount} report{reportCount === 1 ? "" : "s"}
          {summary.policyDomain ? ` · ${summary.policyDomain}` : ""}
          {summary.dateBegin !== undefined
            ? ` · ${fmtEpoch(summary.dateBegin)} → ${fmtEpoch(summary.dateEnd)}`
            : ""}
        </p>
        <div className="mt-4 grid gap-6 sm:grid-cols-4">
          <Stat label="Messages" value={summary.totalMessages.toLocaleString()} />
          <Stat
            label="DMARC pass"
            value={`${passRate}%`}
            tone={passRate >= 95 ? "good" : passRate >= 80 ? "warn" : "bad"}
            flag={passRate < 95}
          />
          <Stat
            label="DKIM aligned"
            value={`${pct(summary.dkimAlignedPass, summary.totalMessages)}%`}
          />
          <Stat
            label="SPF aligned"
            value={`${pct(summary.spfAlignedPass, summary.totalMessages)}%`}
          />
        </div>
        {summary.publishedPolicy && (
          <p className="mt-4 text-sm text-bone/50">
            Published policy:{" "}
            <span className="font-mono text-bone/80">
              p={summary.publishedPolicy}
              {summary.publishedPct && summary.publishedPct !== "100"
                ? `; pct=${summary.publishedPct}`
                : ""}
            </span>
            {summary.publishedPolicy === "none" && " — monitoring only, not yet enforcing."}
            {summary.publishedPct && summary.publishedPct !== "100" && (
              <span>
                {" "}
                — enforcement is sampled at {summary.publishedPct}% of mail, so totals reflect only
                sampled traffic.
              </span>
            )}
          </p>
        )}
      </div>

      {/* Disposition breakdown */}
      <div
        className="grid gap-px bg-bone/5 sm:grid-cols-3"
        style={{ borderRadius: "2px", overflow: "hidden" }}
      >
        <DispCell
          label="Delivered"
          value={summary.delivered}
          total={summary.totalMessages}
          icon="ok"
        />
        <DispCell
          label="Quarantined"
          value={summary.quarantined}
          total={summary.totalMessages}
          icon="warn"
        />
        <DispCell
          label="Rejected"
          value={summary.rejected}
          total={summary.totalMessages}
          icon="bad"
        />
      </div>

      {/* Override reasons — explains failing-but-delivered mail */}
      {summary.overrideReasons.length > 0 && (
        <div
          className="border border-bone/10 bg-midnight p-5 text-sm"
          style={{ borderRadius: "2px" }}
        >
          <h3 className="mb-2 text-base font-medium text-bone">Policy overrides</h3>
          <p className="mb-3 text-bone/50">
            Receivers chose not to enforce the policy for some mail — usually because it was
            forwarded or sent to a mailing list, not because it was malicious.
          </p>
          <div className="flex flex-wrap gap-2">
            {summary.overrideReasons.map((r) => (
              <span
                key={r.type}
                className="border border-bone/15 px-2 py-1 text-xs text-bone/70"
                style={{ borderRadius: "2px" }}
              >
                {r.type}: {r.count.toLocaleString()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Flagged sources */}
      {summary.failingSources.length > 0 && (
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-base font-medium text-bone">
            <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
            Sources to investigate
          </h3>
          <p className="mb-3 text-sm text-bone/50">
            These sent mail as your domain that failed DMARC or got quarantined/rejected. Some may
            be legitimate senders you forgot about — others may be spoofing attempts that DMARC
            stopped.
          </p>
          <SourceTable sources={summary.failingSources.slice(0, 50)} highlightFail />
        </div>
      )}

      {/* Top sources */}
      <div>
        <h3 className="mb-3 text-base font-medium text-bone">Top sending sources</h3>
        <SourceTable sources={summary.sources.slice(0, 50)} />
        {summary.sources.length > 50 && (
          <p className="mt-2 text-xs text-bone/40">
            Showing the 50 highest-volume of {summary.sources.length} sources.
          </p>
        )}
      </div>

      {/* Selectors seen → feed the checker */}
      {summary.selectorsSeen.length > 0 && (
        <div className="border border-bone/10 bg-midnight p-5" style={{ borderRadius: "2px" }}>
          <h3 className="mb-2 text-base font-medium text-bone">DKIM selectors in use</h3>
          <p className="mb-3 text-sm text-bone/50">
            The selectors your mail is actually signing with. Handy if you want to verify them in
            the{" "}
            <Link
              href="/tools/dmarc-check"
              className="text-conviction underline underline-offset-2"
            >
              records checker
            </Link>
            .
          </p>
          <div className="flex flex-wrap gap-2">
            {summary.selectorsSeen.slice(0, MAX_SELECTORS_SHOWN).map((s) => (
              <span
                key={s}
                className="border border-conviction/30 px-2 py-1 font-mono text-xs text-bone/70"
                style={{ borderRadius: "2px" }}
              >
                {s}
              </span>
            ))}
          </div>
          {summary.selectorsSeen.length > MAX_SELECTORS_SHOWN && (
            <p className="mt-2 text-xs text-bone/40">
              Showing {MAX_SELECTORS_SHOWN} of {summary.selectorsSeen.length} selectors.
            </p>
          )}
        </div>
      )}

      {summary.reporters.length > 0 && (
        <p className="text-xs text-bone/40">Reporters: {summary.reporters.join(", ")}</p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  flag,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
  flag?: boolean;
}) {
  const color =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-rose-400"
          : "text-bone";
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.1em] text-bone/40">{label}</p>
      <p className={`mt-1 flex items-center gap-1.5 text-2xl font-medium ${color}`}>
        {flag && <AlertTriangle className="h-4 w-4" aria-label="needs attention" />}
        {value}
      </p>
    </div>
  );
}

function DispCell({
  label,
  value,
  total,
  icon,
}: {
  label: string;
  value: number;
  total: number;
  icon: "ok" | "warn" | "bad";
}) {
  const Icon = icon === "ok" ? CheckCircle2 : icon === "warn" ? AlertTriangle : XCircle;
  const color =
    icon === "ok" ? "text-emerald-400" : icon === "warn" ? "text-amber-400" : "text-rose-400";
  return (
    <div className="bg-midnight p-5">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${color}`} aria-hidden="true" />
        <p className="text-sm text-bone/60">{label}</p>
      </div>
      <p className="mt-2 text-xl font-medium text-bone">{value.toLocaleString()}</p>
      <p className="text-xs text-bone/40">{pct(value, total)}% of mail</p>
    </div>
  );
}

function SourceTable({
  sources,
  highlightFail,
}: {
  sources: {
    sourceIp: string;
    total: number;
    dmarcPass: number;
    dmarcFail: number;
    quarantined: number;
    rejected: number;
    authDomains: string[];
  }[];
  highlightFail?: boolean;
}) {
  return (
    <div
      className="overflow-x-auto border border-bone/10"
      style={{ borderRadius: "2px" }}
      tabIndex={0}
      role="region"
      aria-label="Sending sources table — scroll horizontally for detail"
    >
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-bone/10 text-xs uppercase tracking-[0.1em] text-bone/40">
            <th className="px-4 py-2 font-medium">Source IP</th>
            <th className="px-4 py-2 font-medium">Messages</th>
            <th className="px-4 py-2 font-medium">DMARC</th>
            <th className="px-4 py-2 font-medium">Signed as</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const failing = s.dmarcFail > 0 || s.quarantined > 0 || s.rejected > 0;
            return (
              <tr key={s.sourceIp} className="border-b border-bone/5 last:border-0">
                <td className="px-4 py-2 font-mono text-bone/80">{s.sourceIp}</td>
                <td className="px-4 py-2 text-bone/60">{s.total.toLocaleString()}</td>
                <td className="px-4 py-2">
                  {failing ? (
                    <span
                      className={`inline-flex items-center gap-1 ${highlightFail ? "text-rose-400" : "text-amber-400"}`}
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      {s.dmarcPass > 0 ? `${s.dmarcPass} pass / ` : ""}
                      {s.dmarcFail} fail
                      {s.quarantined ? `, ${s.quarantined} quar` : ""}
                      {s.rejected ? `, ${s.rejected} rej` : ""}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      all pass
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-bone/50">
                  {s.authDomains.length ? s.authDomains.slice(0, 3).join(", ") : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
