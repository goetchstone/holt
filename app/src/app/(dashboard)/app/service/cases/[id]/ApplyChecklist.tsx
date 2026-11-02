"use client";

// /app/src/app/(dashboard)/app/service/cases/[id]/ApplyChecklist.tsx
//
// GAP-11: give the case one of the store's checklists (Settings > Service).
// Each step becomes one of the case's tasks, due its days after today
// (POST /api/service/cases/[id]/checklist). Shows nothing while the store has
// no checklists switched on.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import type { ChecklistOption } from "@/lib/service/checklistsShared";

export function ApplyChecklist({ caseId, onApplied }: { caseId: number; onApplied: () => void }) {
  const [options, setOptions] = useState<ChecklistOption[]>([]);
  const [chosen, setChosen] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let live = true;
    axios
      .get<ChecklistOption[]>("/api/service/checklists")
      .then((res) => {
        if (live) setOptions(res.data);
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (options.length === 0) return null;

  const apply = async () => {
    if (!chosen) return;
    setApplying(true);
    try {
      const res = await axios.post<{ name: string; created: number }>(
        `/api/service/cases/${caseId}/checklist`,
        { checklistId: Number(chosen) },
      );
      const tasks = res.data.created === 1 ? "1 task" : `${res.data.created} tasks`;
      toast.success(`Added ${tasks} from ${res.data.name}.`);
      setChosen("");
      onApplied();
    } catch (err) {
      // The route says why (rule 11): already on this case, switched off.
      toast.error(getErrorMessage(err, "Failed to add the checklist."));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <select
        aria-label="Checklist"
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        className="border border-brand-gray/30 rounded px-2 py-2 text-sm"
      >
        <option value="">Add a checklist...</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.stepCount === 1 ? "1 step" : `${o.stepCount} steps`})
          </option>
        ))}
      </select>
      <Button variant="secondary" size="sm" onClick={apply} disabled={applying || !chosen}>
        {applying ? "Adding..." : "Add its tasks"}
      </Button>
    </div>
  );
}
