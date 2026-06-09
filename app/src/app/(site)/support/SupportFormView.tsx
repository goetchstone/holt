// /app/src/app/(site)/support/SupportFormView.tsx
//
// Public support form. Submits to the rate-limited public POST /api/tickets and,
// on success, shows the ticket number plus a link to the no-login status page so
// the visitor can track + reply without an account.

"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface SubmitResult {
  ticketNumber: string;
  publicToken: string;
}

const FIELD_CLASS =
  "mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none";

export function SupportFormView() {
  const [submitterName, setName] = useState("");
  const [submitterEmail, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submitterName, submitterEmail, subject, body }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not submit");
      const { ticket } = (await res.json()) as { ticket: SubmitResult };
      setResult(ticket);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not submit your request"));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="mt-8 rounded-md border border-green-200 bg-green-50 p-6">
        <h2 className="font-serif text-2xl text-sh-navy">Thanks — we&apos;ve got it.</h2>
        <p className="mt-2 text-sh-gray">
          Your request <span className="font-mono font-semibold">{result.ticketNumber}</span> is in
          our queue. We&apos;ll reply by email. You can also track it and add details here:
        </p>
        <Link
          href={`/support/${result.publicToken}`}
          className="mt-4 inline-block rounded-md bg-sh-navy px-5 py-3 text-sm font-medium text-white transition hover:bg-sh-blue"
        >
          Track your request
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-sh-black">
          Your name
          <input
            value={submitterName}
            onChange={(e) => setName(e.target.value)}
            required
            className={FIELD_CLASS}
          />
        </label>
        <label className="block text-sm font-medium text-sh-black">
          Email
          <input
            type="email"
            value={submitterEmail}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={FIELD_CLASS}
          />
        </label>
      </div>
      <label className="block text-sm font-medium text-sh-black">
        Subject
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          className={FIELD_CLASS}
        />
      </label>
      <label className="block text-sm font-medium text-sh-black">
        How can we help?
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={6}
          className={FIELD_CLASS}
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="min-h-[44px] rounded-md bg-sh-navy px-6 py-3 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
