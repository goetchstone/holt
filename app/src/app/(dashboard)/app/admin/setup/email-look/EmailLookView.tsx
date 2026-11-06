"use client";

// /app/src/app/(dashboard)/app/admin/setup/email-look/EmailLookView.tsx
//
// Admin > Setup > Email look and wording (GAP-37). The preview runs the real template with
// invented details, in an iframe with no scripts allowed, so it shows what goes out.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import {
  EMAIL_CATALOG,
  EMAIL_KINDS,
  EMAIL_WORDING_FIELDS,
  type EmailKind,
  type EmailWordingOverride,
  type EmailWordingText,
} from "@/lib/email/wordingCatalog";

interface LookForm {
  accent: string;
  showLogo: boolean;
  footer: string;
}

const FIELD_LABELS: Record<keyof EmailWordingText, string> = {
  subject: "Subject",
  heading: "Heading",
  intro: "Opening",
  closing: "Closing",
};

const INPUT = "w-full rounded-md border border-brand-accent-gray px-3 py-2 text-sm";

function formFor(kind: EmailKind, saved?: EmailWordingOverride): EmailWordingText {
  const info = EMAIL_CATALOG[kind];
  return {
    subject: saved?.subject ?? info.subject,
    heading: saved?.heading ?? info.heading,
    intro: saved?.intro ?? info.intro,
    closing: saved?.closing ?? info.closing,
  };
}

export function EmailLookView({
  initialLook,
  hasLogo,
  initialWordings,
}: Readonly<{
  initialLook: LookForm;
  hasLogo: boolean;
  initialWordings: Partial<Record<EmailKind, EmailWordingOverride>>;
}>) {
  const [look, setLook] = useState(initialLook);
  const [wordings, setWordings] = useState(initialWordings);
  const [kind, setKind] = useState<EmailKind>("follow-up");
  const [form, setForm] = useState(() => formFor("follow-up", initialWordings["follow-up"]));
  const [html, setHtml] = useState("");
  const [subject, setSubject] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const info = EMAIL_CATALOG[kind];

  const refresh = useCallback(async () => {
    try {
      const { data } = await axios.post<{ subject: string; html: string }>(
        `/api/admin/email-look/${kind}`,
        { look, wording: form },
      );
      setHtml(data.html);
      setSubject(data.subject);
      setProblem(null);
    } catch (err: unknown) {
      setProblem(getErrorMessage(err, "Couldn't show the preview"));
    }
  }, [kind, look, form]);

  useEffect(() => {
    const timer = setTimeout(refresh, 300);
    return () => clearTimeout(timer);
  }, [refresh]);

  const chooseKind = (next: EmailKind) => {
    setKind(next);
    setForm(formFor(next, wordings[next]));
  };

  const saveLook = async () => {
    setBusy(true);
    try {
      await axios.put("/api/admin/settings", {
        emailAccentColor: look.accent,
        emailShowLogo: look.showLogo,
        emailFooter: look.footer,
      });
      toast.success("Saved");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't save the look"));
    } finally {
      setBusy(false);
    }
  };

  const saveWording = async () => {
    setBusy(true);
    try {
      // What still matches the suggestion stays a suggestion, so it follows the catalog.
      const changed = Object.fromEntries(
        EMAIL_WORDING_FIELDS.map((field) => [
          field,
          form[field] === info[field] ? null : form[field],
        ]),
      );
      const { data } = await axios.put<EmailWordingOverride>(
        `/api/admin/email-look/${kind}`,
        changed,
      );
      setWordings({ ...wordings, [kind]: data });
      toast.success("Saved");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't save the wording"));
    } finally {
      setBusy(false);
    }
  };

  const useSuggested = async () => {
    setBusy(true);
    try {
      await axios.delete(`/api/admin/email-look/${kind}`);
      setWordings({ ...wordings, [kind]: undefined });
      setForm(formFor(kind));
      toast.success("Back to the suggested wording");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't change it back"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">
          Email look and wording
        </h1>
        <p className="text-sm text-brand-gray">
          How every email Holt sends looks, and what each says. The messages customers get about
          their orders have their own wording, at{" "}
          <Link href="/app/admin/setup/customer-messages" className="underline">
            Customer messages
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <section className="space-y-3 rounded-xl border border-brand-accent-gray bg-white p-5">
            <h2 className="font-serif font-semibold text-brand-navy">The look of every email</h2>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="color"
                value={look.accent}
                onChange={(e) => setLook({ ...look, accent: e.target.value })}
                className="h-9 w-14 rounded border border-brand-accent-gray"
              />
              Colour of headings, links and buttons
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                disabled={!hasLogo}
                checked={look.showLogo}
                onChange={(e) => setLook({ ...look, showLogo: e.target.checked })}
              />
              {hasLogo
                ? "Put your logo at the top"
                : "Put your logo at the top (set one in Settings first)"}
            </label>
            <div>
              <label htmlFor="email-footer" className="mb-1 block text-sm text-brand-gray">
                What it says at the foot. Blank says who sent it.
              </label>
              <textarea
                id="email-footer"
                rows={3}
                value={look.footer}
                onChange={(e) => setLook({ ...look, footer: e.target.value })}
                className={INPUT}
              />
            </div>
            <Button type="button" disabled={busy} onClick={saveLook}>
              Save the look
            </Button>
          </section>

          <section className="space-y-3 rounded-xl border border-brand-accent-gray bg-white p-5">
            <h2 className="font-serif font-semibold text-brand-navy">What each one says</h2>
            <div>
              <label htmlFor="email-kind" className="mb-1 block text-sm text-brand-gray">
                Email
              </label>
              <select
                id="email-kind"
                value={kind}
                onChange={(e) => chooseKind(e.target.value as EmailKind)}
                className={INPUT}
              >
                {EMAIL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {EMAIL_CATALOG[k].name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-brand-gray">Goes to: {info.goesTo}.</p>
            </div>
            {EMAIL_WORDING_FIELDS.map((field) => (
              <div key={field}>
                <label htmlFor={`email-${field}`} className="mb-1 block text-sm text-brand-gray">
                  {FIELD_LABELS[field]}
                </label>
                {field === "intro" || field === "closing" ? (
                  <textarea
                    id={`email-${field}`}
                    rows={3}
                    value={form[field]}
                    onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                    className={INPUT}
                  />
                ) : (
                  <input
                    id={`email-${field}`}
                    value={form[field]}
                    onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                    className={INPUT}
                  />
                )}
              </div>
            ))}
            <div className="text-sm text-brand-gray">
              <p>You can use:</p>
              <ul className="mt-1 space-y-0.5">
                {Object.entries(info.placeholders).map(([name, meaning]) => (
                  <li key={name}>
                    <code>{`{${name}}`}</code>: {meaning}
                  </li>
                ))}
              </ul>
              <p className="mt-1">A blank line starts a new paragraph.</p>
            </div>
            {problem ? <p className="text-sm text-red-700">{problem}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy || problem !== null} onClick={saveWording}>
                Save the wording
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={useSuggested}>
                Use the suggested wording
              </Button>
            </div>
          </section>
        </div>

        <section className="rounded-xl border border-brand-accent-gray bg-white p-3 lg:sticky lg:top-4 lg:self-start">
          <h2 className="px-2 font-serif font-semibold text-brand-navy">Preview</h2>
          <p className="px-2 pb-2 text-sm text-brand-gray">Subject: {subject}</p>
          <iframe
            title="Preview of the email"
            sandbox=""
            srcDoc={html}
            className="h-[560px] w-full rounded-md border border-brand-accent-gray"
          />
        </section>
      </div>
    </div>
  );
}
