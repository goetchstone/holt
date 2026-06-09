// /app/src/app/(site)/tools/dmarc-report/page.tsx
//
// Public "DMARC aggregate-report analyzer" landing page. Akritos-only: gated
// behind the dmarcTools feature flag (404 otherwise). The DmarcReportForm does
// all the work client-side — decompress + parse happen in the browser, nothing
// is uploaded. Ported from akritos.com (dark tool palette).

export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight, FileSearch, ShieldCheck, Eye } from "lucide-react";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { DmarcReportForm } from "./DmarcReportForm";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAppSettings();
  const brand = settings.companyName?.trim() || settings.appName;
  const title = `Free DMARC Report Analyzer — Read Your XML Aggregate Reports — ${brand}`;
  const description =
    "Drop the DMARC aggregate (RUA) XML reports your providers email you and get a plain-English summary: who's sending as your domain, what's passing, and which sources to investigate. Runs entirely in your browser — nothing is uploaded.";
  return {
    title,
    description,
    openGraph: { type: "website", title, description, siteName: brand },
    twitter: { card: "summary_large_image", title, description },
  };
}

const whatItDoes = [
  {
    icon: FileSearch,
    title: "Reads the unreadable",
    body: "DMARC aggregate reports are dense XML built for machines. Drop them in — one or a whole batch — and get totals, pass/fail rates, and a ranked list of every source sending as your domain.",
  },
  {
    icon: Eye,
    title: "Surfaces what matters",
    body: "Which legitimate senders are aligned, which sources are failing, and which look like spoofing attempts your policy stopped. The DKIM selectors in use, too — handy for the records checker.",
  },
  {
    icon: ShieldCheck,
    title: "Never leaves your browser",
    body: "These reports expose your sending IPs and mail setup. So there's no upload — every byte is decompressed and analyzed on your own device. We never see your reports.",
  },
];

export default async function DmarcReportPage() {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "dmarcTools")) notFound();

  return (
    <div className="flex flex-col bg-midnight">
      {/* Hero + tool */}
      <section className="px-6 pb-12 pt-16">
        <div className="mx-auto max-w-[860px]">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            Free Tool
          </p>
          <h1 className="text-4xl font-medium tracking-[0.01em] text-bone sm:text-5xl">
            DMARC Report Analyzer
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-bone/60">
            Once DMARC is set up, mail providers start emailing you daily XML &ldquo;aggregate
            reports&rdquo; — dense, machine-readable, and nearly impossible to read by hand. Drop
            them here for a plain-English summary of who&apos;s sending mail as your domain and
            what&apos;s getting through. No upload, no account, no sales sequence.
          </p>

          <div className="mt-10">
            <DmarcReportForm />
          </div>
        </div>
      </section>

      {/* What it does */}
      <section className="border-t border-bone/10 bg-slate-brand/20 px-6 py-24">
        <div className="mx-auto max-w-[1000px]">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            What this tool does
          </p>
          <h2 className="mb-12 text-[28px] font-medium text-bone">
            Your DMARC reports, in plain English.
          </h2>
          <div className="grid gap-8 lg:grid-cols-3">
            {whatItDoes.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="space-y-3 border-l-2 border-conviction/30 pl-5">
                  <Icon className="h-5 w-5 text-conviction" strokeWidth={1.5} />
                  <h3 className="text-base font-medium text-bone">{item.title}</h3>
                  <p className="text-base leading-relaxed text-bone/60">{item.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Why it matters */}
      <section className="border-t border-bone/10 px-6 py-24">
        <div className="mx-auto max-w-[800px] space-y-6">
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            Why read them at all
          </p>
          <h2 className="text-[28px] font-medium text-bone">
            The reports are the whole point of DMARC.
          </h2>
          <div className="space-y-4 text-base leading-relaxed text-bone/60">
            <p>
              Publishing a DMARC record turns on reporting. Within a day, receivers start sending
              you aggregate reports showing every source that sent mail claiming to be your domain —
              legitimate apps you forgot about, marketing platforms, and the occasional spoofing
              attempt.
            </p>
            <p>
              That data is how you safely move from <code className="text-conviction">p=none</code>{" "}
              (monitoring) to <code className="text-conviction">p=quarantine</code> or{" "}
              <code className="text-conviction">p=reject</code> (enforcement) without accidentally
              blocking your own newsletters or invoices. But almost nobody reads them, because raw
              DMARC XML is miserable. This makes it readable.
            </p>
            <p>
              Pair it with the{" "}
              <Link
                href="/tools/dmarc-check"
                className="text-conviction underline underline-offset-2"
              >
                records checker
              </Link>{" "}
              — check your DNS before setup, read your reports after.
            </p>
          </div>
        </div>
      </section>

      {/* Service */}
      <section className="border-t border-bone/10 bg-slate-brand/20 px-6 py-24">
        <div className="mx-auto max-w-[800px] space-y-6">
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            If you&apos;d rather not
          </p>
          <h2 className="text-[28px] font-medium text-bone">We&apos;ll read them for you.</h2>
          <p className="text-base leading-relaxed text-bone/60">
            Email authentication setup includes a monitoring period where we watch the reports,
            confirm every legitimate sender is aligned, and only then tighten the policy to
            enforcement. You don&apos;t have to become a DMARC expert — that&apos;s our job. Free
            one-hour consultation to start.
          </p>
          <div className="pt-2">
            <Link
              href="/book"
              className="inline-flex items-center gap-2 rounded-sm bg-conviction px-6 py-3 text-sm font-medium text-midnight transition-colors hover:bg-conviction/90"
            >
              Book your free hour <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
