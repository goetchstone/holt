"use client";

// /app/src/app/(dashboard)/app/admin/setup/database/PracticeCopyCard.tsx
//
// Saving a practice copy's starting point and going back to it (GAP-28). Shown only
// on a practice copy (page.tsx). The route says why when it can't.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

type Action = "save" | "start-over";

export function PracticeCopyCard({ savedOn }: Readonly<{ savedOn: string | null }>) {
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [working, setWorking] = useState(false);

  const act = async (action: Action) => {
    setWorking(true);
    try {
      await axios.post("/api/admin/database/practice", { action });
      globalThis.location.reload();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "That didn't work"));
      setWorking(false);
      setConfirming(null);
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-6">
      <h2 className="font-serif text-lg font-semibold text-brand-navy">Practice copy</h2>
      <p className="mt-1 text-sm text-brand-navy/80">
        Load your products through the importers, then save that as the starting point. Starting
        over puts everything back the way it was then. Every practice sale, payment and change since
        is gone. Everyone using this copy is interrupted for a moment.
      </p>
      <p className="mt-3 text-sm font-medium text-brand-navy">
        {savedOn ? `Starting point saved ${savedOn}.` : "No starting point saved yet."}
      </p>

      {confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-brand-navy">
            {confirming === "save"
              ? "Keep this copy as it is now as the starting point?"
              : `Lose everything done since ${savedOn}?`}
          </span>
          <Button type="button" disabled={working} onClick={() => act(confirming)}>
            {working ? "Working..." : confirming === "save" ? "Save it" : "Start over"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={working}
            onClick={() => setConfirming(null)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirming("save")}>
            Save as the starting point
          </Button>
          <Button type="button" disabled={!savedOn} onClick={() => setConfirming("start-over")}>
            Start over
          </Button>
        </div>
      )}
    </section>
  );
}
