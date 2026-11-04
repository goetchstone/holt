"use client";

// /app/src/app/(dashboard)/app/inventory/vendors/VendorMergeDialog.tsx
//
// GAP-22: merge a duplicate vendor into the one the store keeps
// (lib/vendors/mergeVendor.ts). Choosing the vendor to keep shows what would
// move and why it can't merge yet (GET /api/vendors/[id]/merge); Merge carries
// it out (POST). Shown only to a holder of admin.data, the key both take.

import { useEffect, useState } from "react";
import axios from "axios";
import { Dialog, DialogPanel, DialogTitle, DialogBackdrop } from "@headlessui/react";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import type { VendorMergePreview } from "@/lib/vendors/vendorMergeShared";

interface VendorOption {
  id: number;
  name: string;
}

/** "12 items, 3 styles and 2 purchase orders" */
function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function VendorMergeDialog({
  vendor,
  onClose,
  onMerged,
}: {
  vendor: { id: number; name: string };
  onClose: () => void;
  onMerged: () => void;
}) {
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [intoId, setIntoId] = useState("");
  const [preview, setPreview] = useState<VendorMergePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    axios
      .get<VendorOption[]>("/api/vendors/vendor-list")
      .then((res) => setVendors(Array.isArray(res.data) ? res.data : []))
      .catch((err: unknown) => toast.error(getErrorMessage(err, "Couldn't load vendors.")));
  }, []);

  const choose = (id: string) => {
    setIntoId(id);
    setPreview(null);
    setLoading(id !== "");
  };

  useEffect(() => {
    if (!intoId) return;
    let current = true;
    axios
      .get<VendorMergePreview>(`/api/vendors/${vendor.id}/merge`, { params: { into: intoId } })
      .then((res) => current && setPreview(res.data))
      .catch((err: unknown) =>
        toast.error(getErrorMessage(err, "Couldn't work out what the merge would do.")),
      )
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [vendor.id, intoId]);

  const merge = async () => {
    if (!preview) return;
    setMerging(true);
    try {
      await axios.post(`/api/vendors/${vendor.id}/merge`, { intoId: Number(intoId) });
      toast.success(`${preview.from.name} merged into ${preview.into.name}.`);
      onMerged();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't merge the vendors."));
      const problems = axios.isAxiosError(err) ? err.response?.data?.problems : undefined;
      if (Array.isArray(problems)) setPreview({ ...preview, problems });
    } finally {
      setMerging(false);
    }
  };

  const others = vendors.filter((v) => v.id !== vendor.id);
  const blocked = !preview || preview.problems.length > 0;
  const mergeLabel = preview ? `Merge into ${preview.into.name}` : "Merge";

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl font-serif text-brand-black">
          <DialogTitle as="h3" className="text-lg font-semibold text-brand-blue mb-2">
            Merge {vendor.name} into another vendor
          </DialogTitle>
          <p className="text-sm text-brand-gray mb-4">
            Everything filed under {vendor.name} moves to the vendor you keep, and {vendor.name} is
            deleted. Imports that still spell &ldquo;{vendor.name}&rdquo; find the kept vendor. A
            merge can&apos;t be undone.
          </p>

          <label htmlFor="merge-into" className="block text-sm font-medium mb-1">
            Keep
          </label>
          <select
            id="merge-into"
            value={intoId}
            onChange={(e) => choose(e.target.value)}
            className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm mb-4"
          >
            <option value="">Choose the vendor to keep…</option>
            {others.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>

          {loading && (
            <p className="text-sm text-brand-gray flex items-center">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking…
            </p>
          )}

          {preview && (
            <div className="space-y-3 text-sm">
              <p>
                {preview.moves.length > 0
                  ? `Moves to ${preview.into.name}: ${listOf(
                      preview.moves.map((m) => `${m.count} ${m.label}`),
                    )}.`
                  : `Nothing else is filed under ${preview.from.name}.`}
              </p>
              {preview.takes.length > 0 && (
                <p>
                  {preview.into.name} takes {preview.from.name}&apos;s {listOf(preview.takes)},
                  which it doesn&apos;t have. Its own details and pricing stay as they are.
                </p>
              )}
              {preview.problems.length > 0 && (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="font-medium text-red-800 mb-1">It can&apos;t merge yet:</p>
                  <ul className="list-disc pl-5 space-y-1 text-red-800">
                    {preview.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-red-800">Fix each of these, then merge.</p>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 mt-6">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={merge} disabled={blocked || loading || merging}>
              {merging ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Merging…
                </>
              ) : (
                mergeLabel
              )}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
