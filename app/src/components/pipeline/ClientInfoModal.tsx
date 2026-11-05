// /app/src/components/pipeline/ClientInfoModal.tsx

import { useEffect, useState } from "react";
import axios from "axios";
import { Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { NextFollowUpPicker } from "@/components/pipeline/NextFollowUpPicker";
import {
  CLOSE_LIKELIHOOD_MAX,
  CLOSE_LIKELIHOOD_MIN,
  DEFAULT_CLIENT_PROFILE_CHOICES,
  withSavedAnswer,
  type ClientProfileChoices,
  type ClientProfileView,
} from "@/lib/clientProfile";
import { getErrorMessage } from "@/lib/toastError";

const CLOSE_LIKELIHOOD_SCALE = Array.from(
  { length: CLOSE_LIKELIHOOD_MAX - CLOSE_LIKELIHOOD_MIN + 1 },
  (_, i) => CLOSE_LIKELIHOOD_MIN + i,
);

function chipClass(selected: boolean): string {
  const state = selected
    ? "bg-brand-blue text-white border-brand-blue"
    : "border-brand-gray/30 text-brand-gray hover:border-brand-blue";
  return `px-3 py-2 rounded-lg border text-xs font-semibold transition-colors min-h-[44px] ${state}`;
}

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div>
      <p className="text-xs text-brand-gray uppercase tracking-wide mb-2">{label}</p>
      {children}
    </div>
  );
}

/** Pick one; tapping the selected chip clears it. */
function SingleChoice({
  label,
  choices,
  value,
  onChange,
}: Readonly<{
  label: string;
  choices: readonly string[];
  value: string | null;
  onChange: (next: string | null) => void;
}>) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={value === choice}
            onClick={() => onChange(value === choice ? null : choice)}
            className={chipClass(value === choice)}
          >
            {choice}
          </button>
        ))}
      </div>
    </Field>
  );
}

function MultiChoice({
  label,
  choices,
  value,
  onChange,
}: Readonly<{
  label: string;
  choices: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
}>) {
  function toggle(choice: string) {
    onChange(value.includes(choice) ? value.filter((v) => v !== choice) : [...value, choice]);
  }
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={value.includes(choice)}
            onClick={() => toggle(choice)}
            className={chipClass(value.includes(choice))}
          >
            {choice}
          </button>
        ))}
      </div>
    </Field>
  );
}

function TextField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  placeholder: string;
  value: string | null;
  onChange: (next: string | null) => void;
}>) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-brand-gray uppercase tracking-wide mb-2">
        {label}
      </label>
      <textarea
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        rows={2}
        placeholder={placeholder}
        className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black resize-none focus:outline-none focus:ring-1 focus:ring-brand-blue"
      />
    </div>
  );
}

function KeywordsField({
  value,
  suggested,
  onChange,
}: Readonly<{ value: string[]; suggested: string[]; onChange: (next: string[]) => void }>) {
  const [typed, setTyped] = useState("");
  const custom = value.filter((keyword) => !suggested.includes(keyword));

  function toggle(keyword: string) {
    onChange(value.includes(keyword) ? value.filter((k) => k !== keyword) : [...value, keyword]);
  }

  function addTyped() {
    const keyword = typed.trim();
    if (keyword && !value.includes(keyword)) onChange([...value, keyword]);
    setTyped("");
  }

  return (
    <Field label="Keywords">
      <div className="flex flex-wrap gap-2">
        {[...suggested, ...custom].map((keyword) => (
          <button
            key={keyword}
            type="button"
            aria-pressed={value.includes(keyword)}
            onClick={() => toggle(keyword)}
            className={chipClass(value.includes(keyword))}
          >
            {keyword}
          </button>
        ))}
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTyped();
            }
          }}
          onBlur={addTyped}
          maxLength={60}
          placeholder="Add your own..."
          aria-label="Add a keyword"
          className="w-40 border border-brand-gray/30 rounded-lg px-3 py-2 text-xs text-brand-black min-h-[44px] focus:outline-none focus:ring-1 focus:ring-brand-blue"
        />
      </div>
    </Field>
  );
}

export function ClientInfoModal({
  customerId,
  customerName,
  onClose,
  onSaved,
}: Readonly<{
  customerId: number;
  customerName: string;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const [form, setForm] = useState<ClientProfileView | null>(null);
  const [today, setToday] = useState("");
  const [choices, setChoices] = useState<ClientProfileChoices>(DEFAULT_CLIENT_PROFILE_CHOICES);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Saving replaces the whole profile and an iPad can sit on a page for hours, so
  // start from what's saved now rather than from the copy on the card.
  useEffect(() => {
    let isCurrent = true;
    axios
      .get(`/api/customers/${customerId}/client-profile`)
      .then((res) => {
        if (!isCurrent) return;
        setForm(res.data.profile);
        setChoices(res.data.choices);
        setToday(res.data.today);
      })
      .catch((err) => {
        if (isCurrent) setLoadError(getErrorMessage(err, "Failed to load client info."));
      });
    return () => {
      isCurrent = false;
    };
  }, [customerId]);

  function update(changes: Partial<ClientProfileView>) {
    setForm((current) => current && { ...current, ...changes });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await axios.put(`/api/customers/${customerId}/client-profile`, form);
      toast.success("Client info saved.");
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to save client info."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/40" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-brand-black font-serif">Client Info</h2>
            <p className="text-sm text-brand-gray mt-0.5">
              {customerName} · shows on all their quotes
            </p>
          </div>

          {!form && (
            <p className="text-sm text-brand-gray">{loadError ?? "Loading client info..."}</p>
          )}

          {form && (
            <>
              <div>
                <label
                  htmlFor="client-project-description"
                  className="block text-xs text-brand-gray uppercase tracking-wide mb-2"
                >
                  Project description
                </label>
                <textarea
                  id="client-project-description"
                  value={form.projectDescription ?? ""}
                  onChange={(e) => update({ projectDescription: e.target.value || null })}
                  rows={3}
                  placeholder="Refreshing the living room of their summer home..."
                  className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black resize-none focus:outline-none focus:ring-1 focus:ring-brand-blue"
                />
              </div>

              <MultiChoice
                label="Rooms of interest"
                choices={withSavedAnswer(choices.rooms, form.roomsOfInterest)}
                value={form.roomsOfInterest}
                onChange={(roomsOfInterest) => update({ roomsOfInterest })}
              />
              <TextField
                id="client-style-preferences"
                label="Preferences"
                placeholder="Warm neutrals, transitional, nothing too formal..."
                value={form.stylePreferences}
                onChange={(stylePreferences) => update({ stylePreferences })}
              />
              <SingleChoice
                label="Residence"
                choices={withSavedAnswer(choices.residences, form.residenceType)}
                value={form.residenceType}
                onChange={(residenceType) => update({ residenceType })}
              />
              <TextField
                id="client-homes"
                label="Homes and property types"
                placeholder="Year-round home in town, summer house at the shore..."
                value={form.homes}
                onChange={(homes) => update({ homes })}
              />
              <SingleChoice
                label="Timeline"
                choices={withSavedAnswer(choices.timelines, form.projectTimeline)}
                value={form.projectTimeline}
                onChange={(projectTimeline) => update({ projectTimeline })}
              />
              <SingleChoice
                label="Budget"
                choices={withSavedAnswer(choices.budgets, form.budgetRange)}
                value={form.budgetRange}
                onChange={(budgetRange) => update({ budgetRange })}
              />
              <SingleChoice
                label="Decision making"
                choices={withSavedAnswer(choices.decisionMakers, form.decisionMaker)}
                value={form.decisionMaker}
                onChange={(decisionMaker) => update({ decisionMaker })}
              />

              <TextField
                id="client-preferred-brands"
                label="Preferred brands"
                placeholder="Loved the sofa they bought last year, asked about recliners..."
                value={form.preferredBrands}
                onChange={(preferredBrands) => update({ preferredBrands })}
              />
              <KeywordsField
                suggested={choices.suggestedKeywords}
                value={form.keywords}
                onChange={(keywords) => update({ keywords })}
              />

              <Field label="Closing likelihood">
                <div className="flex flex-wrap gap-1.5">
                  {CLOSE_LIKELIHOOD_SCALE.map((score) => (
                    <button
                      key={score}
                      type="button"
                      aria-pressed={form.closeLikelihood === score}
                      onClick={() =>
                        update({ closeLikelihood: form.closeLikelihood === score ? null : score })
                      }
                      className={`${chipClass(form.closeLikelihood === score)} min-w-[44px]`}
                    >
                      {score}
                    </button>
                  ))}
                </div>
              </Field>

              <div>
                <label
                  htmlFor="client-expected-close"
                  className="block text-xs text-brand-gray uppercase tracking-wide mb-2"
                >
                  Expected close date
                </label>
                <input
                  id="client-expected-close"
                  type="date"
                  value={form.expectedCloseDate ?? ""}
                  onChange={(e) => update({ expectedCloseDate: e.target.value || null })}
                  className="border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black min-h-[44px] focus:outline-none focus:ring-1 focus:ring-brand-blue"
                />
              </div>

              <MultiChoice
                label="What's next"
                choices={withSavedAnswer(choices.nextSteps, form.nextSteps)}
                value={form.nextSteps}
                onChange={(nextSteps) => update({ nextSteps })}
              />
              <NextFollowUpPicker
                value={form.nextFollowUpDate}
                today={today}
                onChange={(nextFollowUpDate) => update({ nextFollowUpDate })}
              />
            </>
          )}

          <div className="flex gap-3 pt-1">
            <Button onClick={handleSave} disabled={saving || !form} className="flex-1 min-h-[44px]">
              {saving ? "Saving..." : "Save Client Info"}
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-brand-gray/30 text-brand-gray text-sm min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
