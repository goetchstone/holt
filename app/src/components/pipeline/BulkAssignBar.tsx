// /app/src/components/pipeline/BulkAssignBar.tsx

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BulkAssignBar({
  clientCount,
  workedWith,
  options,
  onAssign,
}: Readonly<{
  clientCount: number;
  workedWith: string;
  options: { id: number; displayName: string }[];
  onAssign: (toStaffId: number, toStaffName: string) => Promise<void>;
}>) {
  const [toStaffId, setToStaffId] = useState("");
  const [saving, setSaving] = useState(false);
  const target = options.find((option) => String(option.id) === toStaffId);

  async function handleAssign() {
    if (!target) return;
    const confirmed = confirm(
      `Assign ${clientCount.toLocaleString("en-US")} clients who worked with ${workedWith} to ${target.displayName}?\n\n` +
        `Their quotes with no owner will show in ${target.displayName}'s pipeline, and their future leads go to ${target.displayName}. ` +
        "Who each sale is credited to doesn't change.",
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      await onAssign(target.id, target.displayName);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-gold/60 bg-white p-3">
      <p className="text-sm text-brand-black">
        Assign all {clientCount.toLocaleString("en-US")} clients who worked with {workedWith} to
      </p>
      <select
        aria-label="Salesperson to assign these clients to"
        value={toStaffId}
        onChange={(e) => setToStaffId(e.target.value)}
        className="rounded-lg border border-brand-gray/30 bg-white px-3 py-2 text-sm text-brand-black min-h-[44px] focus:border-brand-blue focus:outline-none"
      >
        <option value="" disabled>
          Choose a salesperson...
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.displayName}
          </option>
        ))}
      </select>
      <Button onClick={handleAssign} disabled={!target || saving} className="min-h-[44px]">
        {saving ? "Assigning..." : "Assign all"}
      </Button>
    </div>
  );
}
