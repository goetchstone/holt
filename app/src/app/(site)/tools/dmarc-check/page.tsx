// /app/src/app/(site)/tools/dmarc-check/page.tsx
//
// Public "DMARC / SPF / DKIM checker" landing page. Akritos-only: gated behind
// the dmarcTools feature flag, so other tenants get a 404. Server component:
// resolves branding + the gate, then renders the client DmarcCheckForm, which
// posts to /api/tools/dmarc-check. Ported from akritos.com (dark tool palette).

export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Mail, ShieldCheck, MailWarning } from "lucide-react";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { DmarcCheckForm } from "./DmarcCheckForm";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAppSettings();
  const brand = settings.companyName?.trim() || settings.appName;
  const title = `Free DMARC, SPF & DKIM Checker — ${brand}`;
  const description =
    "Free tool: enter your domain to instantly check SPF, DKIM, DMARC, and MX records. Plain-English explanations of what's wrong and how to fix it. No email required to use.";
  return {
    title,
    description,
    openGraph: { type: "website", title, description, siteName: brand },
    twitter: { card: "summary_large_image", title, description },
  };
}

const whatItDoes = [
  {
    icon: Mail,
    title: "Mail Provider Detection",
    body: "Looks up your MX records and identifies the provider — Google Workspace, Microsoft 365, Mailgun, SendGrid, and a few others.",
  },
  {
    icon: ShieldCheck,
    title: "SPF / DKIM / DMARC Check",
    body: "Pulls each record and parses it. SPF gets analyzed for the most common misconfigurations. DKIM probes the static selectors major providers use — Google, Microsoft 365, DreamHost, Mailchimp, SendGrid, Proton, and more. DMARC parses your policy and checks for a reporting address.",
  },
  {
    icon: MailWarning,
    title: "Plain-English Issues",
    body: "Each problem we find gets an explanation in language a non-IT person can act on. No raw DNS jargon, no 'consult your administrator.'",
  },
];

export default async function DmarcCheckPage() {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "dmarcTools")) notFound();

  return (
    <div className="flex flex-col bg-midnight">
      {/* Hero + form */}
      <section className="px-6 pb-12 pt-16">
        <div className="mx-auto max-w-[860px]">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            Free Tool
          </p>
          <h1 className="text-4xl font-medium tracking-[0.01em] text-bone sm:text-5xl">
            DMARC, SPF &amp; DKIM Checker
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-bone/60">
            Enter your domain. We&apos;ll check your SPF, DKIM, and DMARC records, identify common
            misconfigurations, and tell you what to do about them — in plain English. No email
            required, no account, no follow-up sales sequence.
          </p>

          <div className="mt-10">
            <DmarcCheckForm />
          </div>
        </div>
      </section>

      {/* What it checks */}
      <section className="border-t border-bone/10 bg-slate-brand/20 px-6 py-24">
        <div className="mx-auto max-w-[1000px]">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            What this tool does
          </p>
          <h2 className="mb-12 text-[28px] font-medium text-bone">
            Email authentication, decoded.
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
            Why this matters
          </p>
          <h2 className="text-[28px] font-medium text-bone">
            Email authentication is the lock on your domain.
          </h2>
          <div className="space-y-4 text-base leading-relaxed text-bone/60">
            <p>
              Without SPF, DKIM, and DMARC properly configured, anyone in the world can send email
              that looks like it came from your domain. Customers, vendors, and partners get phished
              using your name. Major mail providers — Google, Microsoft, Yahoo — actively
              de-prioritize or block mail from domains without these records.
            </p>
            <p>
              Most small businesses we look at have one of three patterns: nothing set up at all,
              SPF set up but DMARC missing, or DMARC set to{" "}
              <code className="text-conviction">p=none</code> (monitoring only, no enforcement). All
              three leave you spoofable.
            </p>
            <p>
              This tool tells you which one you are. Already set up and getting XML reports in your
              inbox? Read them with the{" "}
              <Link
                href="/tools/dmarc-report"
                className="text-conviction underline underline-offset-2"
              >
                DMARC report analyzer
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      {/* Service offering */}
      <section className="border-t border-bone/10 bg-slate-brand/20 px-6 py-24">
        <div className="mx-auto max-w-[800px] space-y-6">
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-conviction">
            If you want help fixing it
          </p>
          <h2 className="text-[28px] font-medium text-bone">Email Authentication Setup</h2>
          <div className="space-y-4 text-base leading-relaxed text-bone/60">
            <p>
              We&apos;ll set up SPF, DKIM, and DMARC correctly for your domain and your mail
              provider — Google Workspace, Microsoft 365, or anything else. Includes a reporting
              address so you can actually see who&apos;s trying to send mail in your name, a 30-day
              monitoring period at <code className="text-conviction">p=none</code> to catch any
              legitimate senders we missed, then a deliberate move to{" "}
              <code className="text-conviction">p=quarantine</code> or{" "}
              <code className="text-conviction">p=reject</code> once everything aligns cleanly.
            </p>
            <p>
              Flat-fee project work. Quoted after a free one-hour consultation, so you know exactly
              what it costs before we start. Documentation you own — handed to you at the end so you
              can verify the configuration or hand it to whoever runs IT next.
            </p>
          </div>
          <div className="pt-4">
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
