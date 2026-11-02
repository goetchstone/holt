"use client";

// /app/src/app/(dashboard)/app/admin/setup/service/ServiceChecklistsSection.tsx
//
// GAP-11: Settings > Service > Checklists. The store's own checklists for kinds
// of service job, each a list of steps with how many days after it's applied
// each task is due. None ship. Staff add one to a case from the case page.
// Reads and writes /api/service/checklists (lib/service/checklists.ts).

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";
import {
  CHECKLIST_DUE_AFTER_DAYS_MAX,
  CHECKLIST_NAME_MAX,
  CHECKLIST_STEPS_MAX,
  CHECKLIST_STEP_NOTE_MAX,
  CHECKLIST_STEP_TITLE_MAX,
  type ChecklistRow,
} from "@/lib/service/checklistsShared";

/** A step as the form holds it: the due days as typed, blank for none. */
interface StepDraft {
  title: string;
  description: string;
  dueAfterDays: string;
}

interface Draft {
  id: number | null;
  name: string;
  sortOrder: string;
  isActive: boolean;
  steps: StepDraft[];
}

const BLANK_STEP: StepDraft = { title: "", description: "", dueAfterDays: "" };

function draftOf(row: ChecklistRow | null): Draft {
  if (!row) return { id: null, name: "", sortOrder: "0", isActive: true, steps: [BLANK_STEP] };
  return {
    id: row.id,
    name: row.name,
    sortOrder: String(row.sortOrder),
    isActive: row.isActive,
    steps: row.steps.map((s) => ({
      title: s.title,
      description: s.description ?? "",
      dueAfterDays: s.dueAfterDays == null ? "" : String(s.dueAfterDays),
    })),
  };
}

/** The body the routes take; the server checks every field. */
function bodyOf(draft: Draft) {
  return {
    name: draft.name,
    sortOrder: Number.parseInt(draft.sortOrder, 10) || 0,
    isActive: draft.isActive,
    steps: draft.steps.map((s) => ({
      title: s.title,
      description: s.description || null,
      dueAfterDays: s.dueAfterDays.trim() === "" ? null : Number(s.dueAfterDays),
    })),
  };
}

function dueText(days: number | null): string {
  if (days == null) return "no due date";
  if (days === 0) return "due the same day";
  return days === 1 ? "due next day" : `due in ${days} days`;
}

function StepsEditor({
  steps,
  onChange,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
}) {
  const set = (i: number, patch: Partial<StepDraft>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-brand-gray">
        Each step becomes a task on the case, in this order. Leave &ldquo;Due after&rdquo; blank for
        a task with no due date.
      </p>
      {steps.map((step, i) => (
        <div key={i} className="rounded border border-brand-gray/20 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <span className="w-6 pb-2 text-sm text-brand-gray">{i + 1}.</span>
            <input
              aria-label={`Step ${i + 1} title`}
              value={step.title}
              maxLength={CHECKLIST_STEP_TITLE_MAX}
              onChange={(e) => set(i, { title: e.target.value })}
              placeholder="Order the part"
              className="min-w-[180px] flex-1 rounded border border-brand-gray/30 px-2 py-2 text-sm"
            />
            <label className="flex items-center gap-1 text-sm text-brand-gray">
              Due after
              <input
                aria-label={`Step ${i + 1} due after days`}
                type="number"
                min={0}
                max={CHECKLIST_DUE_AFTER_DAYS_MAX}
                value={step.dueAfterDays}
                onChange={(e) => set(i, { dueAfterDays: e.target.value })}
                className="w-20 rounded border border-brand-gray/30 px-2 py-2 text-sm"
              />
              days
            </label>
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="px-2 py-2 text-sm text-brand-gray disabled:opacity-30"
              title="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === steps.length - 1}
              className="px-2 py-2 text-sm text-brand-gray disabled:opacity-30"
              title="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(steps.filter((_, j) => j !== i))}
              disabled={steps.length === 1}
              className="px-2 py-2 text-sm text-brand-gray hover:text-red-600 disabled:opacity-30"
              title="Remove step"
            >
              Remove
            </button>
          </div>
          <input
            aria-label={`Step ${i + 1} note`}
            value={step.description}
            maxLength={CHECKLIST_STEP_NOTE_MAX}
            onChange={(e) => set(i, { description: e.target.value })}
            placeholder="Note for whoever does it (optional)"
            className="mt-2 w-full rounded border border-brand-gray/30 px-2 py-2 text-sm"
          />
        </div>
      ))}
      {steps.length < CHECKLIST_STEPS_MAX && (
        <Button variant="outline" size="sm" onClick={() => onChange([...steps, BLANK_STEP])}>
          Add step
        </Button>
      )}
    </div>
  );
}

export function ServiceChecklistsSection() {
  const [rows, setRows] = useState<ChecklistRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      axios
        .get<ChecklistRow[]>("/api/service/checklists", { params: { all: 1 } })
        .then((res) => setRows(res.data))
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Failed to load checklists."))),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (draft.id) await axios.put(`/api/service/checklists/${draft.id}`, bodyOf(draft));
      else await axios.post("/api/service/checklists", bodyOf(draft));
      toast.success("Checklist saved.");
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to save the checklist."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!window.confirm(`Delete "${draft.name}"? Cases already given it keep their tasks.`)) {
      return;
    }
    setSaving(true);
    try {
      await axios.delete(`/api/service/checklists/${draft.id}`);
      toast.success("Checklist deleted.");
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to delete the checklist."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-brand-black">Checklists</h2>
        <Button variant="primary" size="sm" onClick={() => setDraft(draftOf(null))}>
          Add Checklist
        </Button>
      </div>
      <p className="mb-4 text-sm text-brand-gray">
        The steps a kind of service job takes. Adding one to a case gives the case a task for each
        step. Changing a checklist later doesn&rsquo;t change cases already given it.
      </p>
      {rows.length === 0 ? (
        <p className="p-3 text-center text-sm text-brand-gray">No checklists yet</p>
      ) : (
        <ul className="divide-y divide-brand-gray/10">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="font-medium text-brand-black">
                  {row.name}
                  {!row.isActive && <span className="ml-2 text-xs text-brand-gray">(off)</span>}
                </p>
                <ol className="mt-1 list-decimal pl-5 text-sm text-brand-gray">
                  {row.steps.map((s, i) => (
                    <li key={i}>
                      {s.title} <span className="text-xs">· {dueText(s.dueAfterDays)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <button
                onClick={() => setDraft(draftOf(row))}
                className="text-sm text-brand-blue hover:underline"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <Modal
          title={draft.id ? "Edit Checklist" : "Add Checklist"}
          onClose={() => setDraft(null)}
          onSave={save}
          saving={saving}
        >
          <FormInput
            label="Name"
            name="checklistName"
            value={draft.name}
            onChange={(v) => setDraft((d) => d && { ...d, name: v.slice(0, CHECKLIST_NAME_MAX) })}
            placeholder="Recliner mechanism repair"
            required
          />
          <FormInput
            label="Sort Order"
            name="checklistSortOrder"
            type="number"
            value={draft.sortOrder}
            onChange={(v) => setDraft((d) => d && { ...d, sortOrder: v })}
          />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="checklistActive"
              checked={draft.isActive}
              onChange={(e) => setDraft((d) => d && { ...d, isActive: e.target.checked })}
              className="rounded"
            />
            <label htmlFor="checklistActive" className="text-sm text-brand-gray">
              Active (offered on cases)
            </label>
          </div>
          <StepsEditor
            steps={draft.steps}
            onChange={(steps) => setDraft((d) => d && { ...d, steps })}
          />
          {draft.id && (
            <div className="border-t border-brand-gray/10 pt-3">
              <button
                type="button"
                onClick={remove}
                disabled={saving}
                className="text-sm text-red-700 hover:underline"
              >
                Delete checklist
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
