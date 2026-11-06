"use client";

// /app/src/app/(dashboard)/app/admin/automations/AutomationsView.tsx
//
// Admin > Automations (GAP-37). Each automation saves on its own, so changing one can't
// disturb another, and Run now shows what it did straight away.

import { useState } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import {
  AUTOMATION_CATALOG,
  MINUTE_CHOICES,
  WEEKDAY_NAMES,
  describeSchedule,
  hourLabel,
  type AutomationFrequency,
  type AutomationKey,
} from "@/lib/automations/catalog";

interface Row {
  key: AutomationKey;
  isActive: boolean;
  frequency: AutomationFrequency;
  everyMinutes: number | null;
  hour: number | null;
  weekday: number | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: "RUNNING" | "OK" | "FAILED" | "SKIPPED" | null;
  lastSummary: string | null;
}

const FREQUENCY_LABELS: Record<AutomationFrequency, string> = {
  EVERY_MINUTES: "Every few minutes",
  HOURLY: "Every hour",
  DAILY: "Every day",
  WEEKLY: "Every week",
};

const STATUS_LABELS: Record<NonNullable<Row["lastStatus"]>, string> = {
  RUNNING: "Running",
  OK: "Finished",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

const STATUS_CLASSES: Record<NonNullable<Row["lastStatus"]>, string> = {
  RUNNING: "text-brand-navy",
  OK: "text-green-700",
  FAILED: "text-red-700 font-semibold",
  SKIPPED: "text-amber-800",
};

const FIELD = "rounded-md border border-brand-accent-gray px-3 py-2 text-sm";

function AutomationCard({
  initial,
  notReady,
  when,
}: Readonly<{
  initial: Row;
  notReady?: string;
  when: (iso: string) => string;
}>) {
  const info = AUTOMATION_CATALOG[initial.key];
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);

  const dirty =
    form.isActive !== saved.isActive ||
    form.frequency !== saved.frequency ||
    form.everyMinutes !== saved.everyMinutes ||
    form.hour !== saved.hour ||
    form.weekday !== saved.weekday;

  const changeFrequency = (frequency: AutomationFrequency) =>
    setForm({
      ...form,
      frequency,
      everyMinutes: frequency === "EVERY_MINUTES" ? (form.everyMinutes ?? MINUTE_CHOICES[0]) : null,
      hour: frequency === "DAILY" || frequency === "WEEKLY" ? (form.hour ?? 6) : null,
      weekday: frequency === "WEEKLY" ? (form.weekday ?? 0) : null,
    });

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await axios.put<Row>(`/api/admin/automations/${initial.key}`, form);
      setSaved(data);
      setForm(data);
      toast.success("Saved");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't save that"));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const { data } = await axios.post<Row>(`/api/admin/automations/${initial.key}`);
      setSaved(data);
      setForm({ ...form, lastStartedAt: data.lastStartedAt, lastStatus: data.lastStatus });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't run it"));
    } finally {
      setBusy(false);
    }
  };

  const id = `automation-${initial.key}`;
  return (
    <section className="rounded-xl border border-brand-accent-gray bg-white p-5">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
        />
        <span>
          <span className="block font-serif font-semibold text-brand-navy">{info.name}</span>
          <span className="block text-sm text-brand-gray">{info.does}</span>
        </span>
      </label>

      {form.isActive ? null : (
        <p className="mt-2 text-sm text-brand-gray">While it&apos;s off: {info.whenOff}</p>
      )}
      {notReady ? <p className="mt-2 text-sm text-amber-800">{notReady}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-frequency`} className="sr-only">
          How often
        </label>
        <select
          id={`${id}-frequency`}
          value={form.frequency}
          onChange={(e) => changeFrequency(e.target.value as AutomationFrequency)}
          className={FIELD}
        >
          {info.frequencies.map((frequency) => (
            <option key={frequency} value={frequency}>
              {FREQUENCY_LABELS[frequency]}
            </option>
          ))}
        </select>
        {form.frequency === "EVERY_MINUTES" ? (
          <select
            aria-label="Every how many minutes"
            value={form.everyMinutes ?? MINUTE_CHOICES[0]}
            onChange={(e) => setForm({ ...form, everyMinutes: Number(e.target.value) })}
            className={FIELD}
          >
            {MINUTE_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
        ) : null}
        {form.frequency === "WEEKLY" ? (
          <select
            aria-label="On which day"
            value={form.weekday ?? 0}
            onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
            className={FIELD}
          >
            {WEEKDAY_NAMES.map((name, weekday) => (
              <option key={name} value={weekday}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
        {form.frequency === "DAILY" || form.frequency === "WEEKLY" ? (
          <select
            aria-label="At what time"
            value={form.hour ?? 6}
            onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}
            className={FIELD}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="button" disabled={!dirty || busy} onClick={save}>
          Save
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={runNow}>
          {busy ? "Working..." : "Run now"}
        </Button>
      </div>

      <p className="mt-3 text-sm text-brand-gray">
        {saved.isActive ? describeSchedule(saved) : "Off"}
        {" · "}
        {saved.lastStatus && saved.lastStartedAt ? (
          <>
            Last ran {when(saved.lastStartedAt)}:{" "}
            <span className={STATUS_CLASSES[saved.lastStatus]}>
              {STATUS_LABELS[saved.lastStatus]}
            </span>
            {saved.lastSummary ? `. ${saved.lastSummary}` : ""}
          </>
        ) : (
          "Hasn't run yet"
        )}
      </p>
      {info.detailsHref ? (
        <Link href={info.detailsHref} className="mt-1 inline-block text-sm underline">
          See its history
        </Link>
      ) : null}
    </section>
  );
}

export function AutomationsView({
  rows,
  notReady,
  wokenAt,
  wokenLate,
  messages,
  timeZone,
  locale,
}: Readonly<{
  rows: Row[];
  notReady: Partial<Record<AutomationKey, string>>;
  wokenAt: string | null;
  wokenLate: boolean;
  messages: { name: string; state: string; href: string }[];
  timeZone: string;
  locale: string;
}>) {
  const format = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const when = (iso: string) => format.format(new Date(iso));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">Automations</h1>
        <p className="text-sm text-brand-gray">
          What Holt does by itself. Turn each on or off and choose when it runs. Times are your
          store&apos;s.
        </p>
      </div>

      {wokenLate ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-semibold text-red-800">Nothing here is running by itself.</p>
          <p className="text-red-800">
            {wokenAt ? `Holt was last woken ${when(wokenAt)}.` : "Holt has never been woken."}{" "}
            Whoever hosts your Holt needs to run <code>scripts/install-cron.sh</code>, once. You can
            still use Run now.
          </p>
        </div>
      ) : null}

      {rows.map((row) => (
        <AutomationCard key={row.key} initial={row} notReady={notReady[row.key]} when={when} />
      ))}

      <section className="rounded-xl border border-brand-accent-gray bg-white p-5">
        <h2 className="font-serif font-semibold text-brand-navy">What it sends</h2>
        <p className="text-sm text-brand-gray">
          These go out through &quot;Send waiting emails and texts&quot;, and have their own
          settings.
        </p>
        <ul className="mt-2 divide-y divide-brand-accent-gray text-sm">
          {messages.map((message) => (
            <li key={message.name} className="flex items-center justify-between gap-3 py-2">
              <Link href={message.href} className="underline">
                {message.name}
              </Link>
              <span className="text-brand-gray">{message.state}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
