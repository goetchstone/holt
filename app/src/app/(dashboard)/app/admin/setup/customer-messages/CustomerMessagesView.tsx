"use client";

// /app/src/app/(dashboard)/app/admin/setup/customer-messages/CustomerMessagesView.tsx
//
// Settings -> Customer messages: each automatic message (lib/messages/
// catalog.ts) on or off, its subject and wording, whether it carries the
// customer's order link, and when it goes. The same check the server makes
// runs here first (messageSettingProblem). Reads and writes
// /api/customer-messages.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import {
  BODY_MAX,
  CHANNEL_LABELS,
  LINK_MAX,
  MESSAGE_CHANNELS,
  OFFSET_DAYS_MAX,
  PLACEHOLDERS,
  SUBJECT_MAX,
  TEXT_MAX,
  messageSettingProblem,
  type MessageChannel,
  type MessageDefaults,
  type MessageKind,
  type MessageSettingInput,
  type MessageTiming,
  type Placeholder,
} from "@/lib/messages/catalog";
import { fillPlaceholders, renderTextMessage } from "@/lib/messages/render";

interface MessageRow extends MessageSettingInput {
  kind: MessageKind;
  label: string;
  sentWhen: string;
  placeholders: Placeholder[];
  timing: MessageTiming;
  needsLink: boolean;
  defaults: MessageDefaults;
  activeSince: string | null;
  updated: string | null;
}

interface Props {
  storeName: string;
  timeZone: string;
  /** Whether a text provider is set up (Settings > Integrations). */
  textingSetUp: boolean;
}

const INPUT = "w-full rounded-md border border-brand-accent-gray px-3 py-2";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, 0, 1, h)),
  );
}

export function CustomerMessagesView({ storeName, timeZone, textingSetUp }: Readonly<Props>) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      axios
        .get<MessageRow[]>("/api/customer-messages")
        .then((res) => setMessages(res.data))
        .catch((err: unknown) =>
          toast.error(getErrorMessage(err, "Couldn't load the customer messages.")),
        )
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="py-2 font-serif">
      <div className="mb-6 max-w-2xl space-y-2 text-brand-gray">
        <p>
          Messages Holt sends your customers by itself, by email or text. Each starts switched off:
          switch on the ones you want, in your own words. Switching one on sends nothing about what
          had already happened, only what happens from then on.
        </p>
        <p className="text-sm">
          A customer who asked for no automatic messages (on their customer record) gets none of
          these. An email needs an address. A text needs a mobile number and their agreement, ticked
          on their customer record, and stops if the number replies STOP. The order page shows each
          message, sent or not. Times are your store&apos;s ({timeZone}). Admin › Email shows what
          has gone out.
        </p>
        {!textingSetUp && (
          <p className="text-sm">
            Texting isn&apos;t set up, so a message can only go by email until it is, in Settings ›
            Integrations.
          </p>
        )}
      </div>
      {loading && <p className="text-brand-gray">Loading...</p>}
      <ul className="max-w-3xl space-y-6">
        {messages.map((m) => (
          // Keyed on when it was saved, so a save starts the form again from what the server kept.
          <MessageItem
            key={`${m.kind}-${m.updated ?? ""}`}
            message={m}
            storeName={storeName}
            onSaved={load}
          />
        ))}
      </ul>
    </div>
  );
}

function inputOf(m: MessageSettingInput): MessageSettingInput {
  const { isActive, subject, body, includeOrderLink, offsetDays, sendHour, linkUrl } = m;
  const { channel, textBody, textIncludeOrderLink } = m;
  return {
    isActive,
    subject,
    body,
    includeOrderLink,
    offsetDays,
    sendHour,
    linkUrl,
    channel,
    textBody,
    textIncludeOrderLink,
  };
}

function MessageItem({
  message,
  storeName,
  onSaved,
}: Readonly<{ message: MessageRow; storeName: string; onSaved: () => Promise<unknown> }>) {
  const [form, setForm] = useState<MessageSettingInput>(inputOf(message));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<MessageSettingInput>) => setForm((f) => ({ ...f, ...patch }));
  const problem = messageSettingProblem(message.kind, form);
  const changed = JSON.stringify(form) !== JSON.stringify(inputOf(message));
  const id = (field: string) => `${message.kind}-${field}`;

  const save = async () => {
    setSaving(true);
    try {
      await axios.put(`/api/customer-messages/${message.kind}`, form);
      toast.success(`${message.label}: saved.`);
      await onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the message."));
    } finally {
      setSaving(false);
    }
  };

  const example = {
    customer: "Jordan",
    order: "SO-1042",
    store: storeName,
    pieces: "Hartwell Sofa and 2 × Ellis Side Chair",
    when: "Thursday, November 12, 9am-12pm",
  };

  return (
    <li className="rounded-lg border border-brand-gray/20 bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{message.label}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => set({ isActive: e.target.checked })}
          />
          On
        </label>
        {message.isActive && message.activeSince && (
          <span className="text-xs text-brand-gray">
            On since {new Date(message.activeSince).toLocaleString()}
          </span>
        )}
      </div>
      <p className="text-sm text-brand-gray">Sent when: {message.sentWhen}</p>

      <div>
        <label htmlFor={id("channel")} className="mb-1 block text-sm text-brand-gray">
          How it goes
        </label>
        <select
          id={id("channel")}
          value={form.channel}
          onChange={(e) => set({ channel: e.target.value as MessageChannel })}
          className="rounded-md border border-brand-accent-gray px-3 py-2"
        >
          {MESSAGE_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {CHANNEL_LABELS[channel]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor={id("subject")} className="mb-1 block text-sm text-brand-gray">
          Subject
        </label>
        <input
          id={id("subject")}
          value={form.subject}
          maxLength={SUBJECT_MAX}
          onChange={(e) => set({ subject: e.target.value })}
          className={INPUT}
        />
      </div>
      <div>
        <label htmlFor={id("body")} className="mb-1 block text-sm text-brand-gray">
          Wording (a blank line starts a new paragraph)
        </label>
        <textarea
          id={id("body")}
          value={form.body}
          maxLength={BODY_MAX}
          rows={6}
          onChange={(e) => set({ body: e.target.value })}
          className={INPUT}
        />
        <ul className="mt-1 space-y-0.5 text-xs text-brand-gray">
          {message.placeholders.map((p) => (
            <li key={p}>
              <code>{`{${p}}`}</code> {PLACEHOLDERS[p]}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <label htmlFor={id("text")} className="mb-1 block text-sm text-brand-gray">
          The text&apos;s wording ({form.textBody.length} of {TEXT_MAX} characters, before its link)
        </label>
        <textarea
          id={id("text")}
          value={form.textBody}
          maxLength={TEXT_MAX}
          rows={3}
          onChange={(e) => set({ textBody: e.target.value })}
          className={INPUT}
        />
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.textIncludeOrderLink}
            onChange={(e) => set({ textIncludeOrderLink: e.target.checked })}
          />
          In the text, include a link to their order (about 250 characters, so it costs more)
        </label>
      </div>

      {message.timing !== "at-once" && (
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div>
            <label htmlFor={id("days")} className="mb-1 block text-brand-gray">
              {message.timing === "before-delivery"
                ? "Days before the delivery (0 is the day itself)"
                : "Days after the handover"}
            </label>
            <input
              id={id("days")}
              type="number"
              min={0}
              max={OFFSET_DAYS_MAX}
              value={form.offsetDays ?? ""}
              onChange={(e) =>
                set({ offsetDays: e.target.value === "" ? null : Number(e.target.value) })
              }
              className="w-24 rounded-md border border-brand-accent-gray px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor={id("hour")} className="mb-1 block text-brand-gray">
              At
            </label>
            <select
              id={id("hour")}
              value={form.sendHour ?? ""}
              onChange={(e) =>
                set({ sendHour: e.target.value === "" ? null : Number(e.target.value) })
              }
              className="rounded-md border border-brand-accent-gray px-3 py-2"
            >
              <option value="">Choose...</option>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {message.needsLink && (
        <div>
          <label htmlFor={id("link")} className="mb-1 block text-sm text-brand-gray">
            Your review page (the &quot;Leave a review&quot; button goes here)
          </label>
          <input
            id={id("link")}
            value={form.linkUrl ?? ""}
            maxLength={LINK_MAX}
            placeholder="https://"
            onChange={(e) => set({ linkUrl: e.target.value || null })}
            className={INPUT}
          />
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.includeOrderLink}
          onChange={(e) => set({ includeOrderLink: e.target.checked })}
        />
        In the email, include a &quot;View your order&quot; button (a fresh link to their order)
      </label>

      <details className="text-sm">
        <summary className="cursor-pointer text-brand-gray">Example</summary>
        <div className="mt-2 rounded bg-brand-linen/40 p-3">
          <p className="font-semibold">{fillPlaceholders(form.subject, example)}</p>
          <p className="mt-2 whitespace-pre-wrap">{fillPlaceholders(form.body, example)}</p>
          <p className="mt-3 font-semibold">As a text</p>
          <p className="whitespace-pre-wrap">
            {renderTextMessage({
              body: form.textBody,
              values: example,
              orderUrl: null,
              reviewUrl: null,
            })}
          </p>
        </div>
      </details>

      {problem && <p className="text-sm text-red-700">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={!changed || !!problem || saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => set({ ...message.defaults })}
          disabled={saving}
        >
          Use the suggested wording
        </Button>
      </div>
    </li>
  );
}
