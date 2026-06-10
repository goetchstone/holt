"use client";

// /app/src/components/cms/LeadMagnetForm.tsx
//
// Client half of the leadMagnet CMS block: email capture that POSTs to the
// public /api/lead-magnet endpoint (honeypot + rate-limited server-side) and
// then reveals the gated resource link. The visual band styling lives in the
// server-rendered BlockRenderer wrapper; this is just the form.

import { useState } from "react";

export function LeadMagnetForm({
  buttonLabel,
  emailPlaceholder,
  resourceUrl,
  sourceTag,
  dark,
}: {
  buttonLabel: string;
  emailPlaceholder: string;
  resourceUrl: string;
  sourceTag: string;
  dark: boolean;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const button = dark
    ? "bg-sh-gold text-sh-navy hover:opacity-90"
    : "bg-sh-navy text-white hover:bg-sh-blue";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch("/api/lead-magnet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, sourceTag, website }),
      });
    } finally {
      // The endpoint always answers ok — reveal the resource either way.
      setDone(true);
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="mt-6">
        {resourceUrl ? (
          <a
            href={resourceUrl}
            className={`inline-block rounded-[2px] px-6 py-3 text-sm font-medium transition ${button}`}
          >
            Open your download
          </a>
        ) : (
          <p className={dark ? "text-sh-stripe/80" : "text-sh-gray"}>
            Thanks — we&apos;ll be in touch shortly.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-6 flex max-w-md flex-col gap-3 sm:flex-row">
      {/* Honeypot: visually hidden, tab-skipped. Bots fill it; the server
          accepts silently and drops the submission. */}
      <input
        type="text"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />
      <label className="sr-only" htmlFor="lm-name">
        Name
      </label>
      <input
        id="lm-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="min-h-[44px] flex-1 rounded-[2px] border border-black/15 bg-white px-3 text-sm text-sh-black"
      />
      <label className="sr-only" htmlFor="lm-email">
        Email
      </label>
      <input
        id="lm-email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={emailPlaceholder}
        className="min-h-[44px] flex-1 rounded-[2px] border border-black/15 bg-white px-3 text-sm text-sh-black"
      />
      <button
        type="submit"
        disabled={submitting}
        className={`min-h-[44px] rounded-[2px] px-6 text-sm font-medium transition disabled:opacity-60 ${button}`}
      >
        {submitting ? "Sending…" : buttonLabel || "Get the guide"}
      </button>
    </form>
  );
}
