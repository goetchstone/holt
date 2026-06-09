"use client";

// /app/src/app/(dashboard)/app/admin/service/delivery-zones/DeliveryZonesView.tsx
//
// Delivery Zones body. App Router port of the legacy admin/service/delivery-zones
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Manages
// delivery zones plus their ZIP assignments via the shared
// /api/service/delivery-zones REST endpoints. The ZIP-management panel is a
// sub-component so each piece stays small.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";

interface DeliveryZone {
  id: number;
  name: string;
  description: string | null;
  baseFee: number;
  perPieceFee: number;
  isThirdParty: boolean;
  carrierName: string | null;
  zipCount: number;
  isActive: boolean;
}

interface ZoneForm {
  name: string;
  description: string;
  baseFee: string;
  perPieceFee: string;
  isThirdParty: boolean;
  carrierName: string;
  isActive: boolean;
}

interface ZipAddResult {
  added: number;
  reassigned: { count: number; fromZone: string }[];
  invalid: number;
}

const EMPTY_FORM: ZoneForm = {
  name: "",
  description: "",
  baseFee: "0",
  perPieceFee: "0",
  isThirdParty: false,
  carrierName: "",
  isActive: true,
};

function StatusBadge({ active }: { active: boolean }) {
  const cls = active ? "bg-green-100 text-green-800" : "bg-sh-gray/20 text-sh-gray";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{active ? "Active" : "Inactive"}</span>
  );
}

function ZoneRow({
  zone,
  selected,
  onSelect,
  onEdit,
}: {
  zone: DeliveryZone;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  return (
    <tr
      className={`border-b border-sh-gray/10 hover:bg-sh-stripe/50 cursor-pointer ${
        selected ? "bg-sh-linen" : ""
      }`}
      onClick={onSelect}
    >
      <td className="px-4 py-2 text-sh-black font-medium">{zone.name}</td>
      <td className="px-4 py-2 text-sh-gray text-xs">{zone.description || "--"}</td>
      <td className="px-4 py-2 text-right text-sh-gray">${zone.baseFee.toFixed(2)}</td>
      <td className="px-4 py-2 text-right text-sh-gray">${zone.perPieceFee.toFixed(2)}</td>
      <td className="px-4 py-2 text-sh-gray text-xs">
        {zone.isThirdParty ? zone.carrierName || "Yes" : "No"}
      </td>
      <td className="px-4 py-2 text-right text-sh-gray">{zone.zipCount}</td>
      <td className="px-4 py-2">
        <StatusBadge active={zone.isActive} />
      </td>
      <td className="px-4 py-2 text-right">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="text-sm text-sh-blue hover:underline"
        >
          Edit
        </button>
      </td>
    </tr>
  );
}

function ZipManagementPanel({
  zone,
  onZipsChanged,
}: {
  zone: DeliveryZone;
  onZipsChanged: () => void;
}) {
  const [zoneZips, setZoneZips] = useState<string[]>([]);
  const [zipsLoading, setZipsLoading] = useState(false);
  const [addZipsText, setAddZipsText] = useState("");
  const [addingZips, setAddingZips] = useState(false);
  const [zipSearchQuery, setZipSearchQuery] = useState("");
  const [zipSearchResult, setZipSearchResult] = useState<string | null>(null);
  const [searchingZip, setSearchingZip] = useState(false);

  const loadZips = useCallback(async () => {
    setZipsLoading(true);
    try {
      const res = await axios.get(`/api/service/delivery-zones/${zone.id}/zips`);
      setZoneZips(res.data.zips || []);
    } catch {
      setZoneZips([]);
    } finally {
      setZipsLoading(false);
    }
  }, [zone.id]);

  useEffect(() => {
    loadZips();
  }, [loadZips]);

  const handleAddZips = async () => {
    if (!addZipsText.trim()) return;
    setAddingZips(true);
    try {
      const zips = addZipsText
        .split(/[,\n\r]+/)
        .map((z) => z.trim())
        .filter(Boolean);
      const res = await axios.post(`/api/service/delivery-zones/${zone.id}/zips`, { zips });
      const result: ZipAddResult = res.data;
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.reassigned?.length > 0) {
        result.reassigned.forEach((r) => {
          parts.push(`${r.count} reassigned from ${r.fromZone}`);
        });
      }
      if (result.invalid > 0) parts.push(`${result.invalid} invalid`);
      toast.success(parts.join(", ") || "ZIPs updated");
      setAddZipsText("");
      await loadZips();
      onZipsChanged();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to add ZIPs"));
    } finally {
      setAddingZips(false);
    }
  };

  const removeZip = async (zip: string) => {
    try {
      await axios.delete(`/api/service/delivery-zones/${zone.id}/zips`, {
        data: { zips: [zip] },
      });
      setZoneZips((prev) => prev.filter((z) => z !== zip));
      onZipsChanged();
    } catch {
      toast.error("Failed to remove ZIP");
    }
  };

  const searchZip = async () => {
    if (!zipSearchQuery.trim()) return;
    setSearchingZip(true);
    setZipSearchResult(null);
    try {
      const res = await axios.get("/api/service/delivery-zones", {
        params: { zipCode: zipSearchQuery.trim() },
      });
      const found = res.data.zone;
      setZipSearchResult(
        found
          ? `ZIP ${zipSearchQuery.trim()} belongs to: ${found.name}`
          : `ZIP ${zipSearchQuery.trim()} is not assigned to any zone`,
      );
    } catch {
      setZipSearchResult("Search failed");
    } finally {
      setSearchingZip(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
      <h2 className="text-lg font-semibold text-sh-black mb-4">ZIP Codes for {zone.name}</h2>

      {/* ZIP Search */}
      <div className="flex items-end gap-3 mb-6">
        <div className="flex-1 max-w-[240px]">
          <label htmlFor="zipSearch" className="block text-xs font-medium text-sh-gray mb-1">
            Search ZIP
          </label>
          <input
            id="zipSearch"
            type="text"
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
            placeholder="Enter ZIP code..."
            value={zipSearchQuery}
            onChange={(e) => {
              setZipSearchQuery(e.target.value);
              setZipSearchResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchZip();
            }}
          />
        </div>
        <Button variant="outline" size="sm" disabled={searchingZip} onClick={searchZip}>
          Search
        </Button>
        {zipSearchResult && <p className="text-sm text-sh-gray self-center">{zipSearchResult}</p>}
      </div>

      {/* Add ZIPs */}
      <div className="mb-6">
        <label htmlFor="addZips" className="block text-xs font-medium text-sh-gray mb-1">
          Add ZIP Codes (comma or newline separated)
        </label>
        <div className="flex gap-3">
          <textarea
            id="addZips"
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm flex-1"
            rows={3}
            placeholder="06520, 06510, 06511..."
            value={addZipsText}
            onChange={(e) => setAddZipsText(e.target.value)}
          />
          <Button
            disabled={addingZips || !addZipsText.trim()}
            onClick={handleAddZips}
            className="self-end"
          >
            {addingZips ? "Adding..." : "Add"}
          </Button>
        </div>
      </div>

      <ZipList zips={zoneZips} loading={zipsLoading} onRemove={removeZip} />
    </div>
  );
}

function ZipList({
  zips,
  loading,
  onRemove,
}: {
  zips: string[];
  loading: boolean;
  onRemove: (zip: string) => void;
}) {
  if (loading) return <p className="text-sh-gray text-sm">Loading ZIPs...</p>;
  if (zips.length === 0)
    return <p className="text-sh-gray text-sm">No ZIP codes assigned to this zone</p>;
  return (
    <div>
      <p className="text-xs font-medium text-sh-gray mb-2">
        {zips.length} ZIP code{zips.length !== 1 ? "s" : ""}
      </p>
      <div className="flex flex-wrap gap-1.5 max-h-[300px] overflow-y-auto">
        {zips.map((zip) => (
          <span
            key={zip}
            className="inline-flex items-center gap-1 bg-sh-stripe border border-sh-gray/20 rounded px-2 py-1 text-xs text-sh-black"
          >
            {zip}
            <button
              type="button"
              className="text-sh-gray hover:text-red-600 ml-0.5 min-w-[16px] min-h-[16px] flex items-center justify-center"
              onClick={() => onRemove(zip)}
              title={`Remove ${zip}`}
            >
              x
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export function DeliveryZonesView() {
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null);

  const [zoneModal, setZoneModal] = useState<{ editing: DeliveryZone | null } | null>(null);
  const [zoneForm, setZoneForm] = useState<ZoneForm>({ ...EMPTY_FORM });
  const [zoneSaving, setZoneSaving] = useState(false);

  const loadZones = useCallback(async () => {
    try {
      const res = await axios.get("/api/service/delivery-zones");
      setZones(res.data.zones || []);
    } catch {
      toast.error("Failed to load delivery zones");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadZones();
  }, [loadZones]);

  const openZoneModal = (zone: DeliveryZone | null) => {
    setZoneForm(
      zone
        ? {
            name: zone.name,
            description: zone.description || "",
            baseFee: String(zone.baseFee),
            perPieceFee: String(zone.perPieceFee),
            isThirdParty: zone.isThirdParty,
            carrierName: zone.carrierName || "",
            isActive: zone.isActive,
          }
        : { ...EMPTY_FORM },
    );
    setZoneModal({ editing: zone });
  };

  const saveZone = async () => {
    if (!zoneForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setZoneSaving(true);
    try {
      const payload = {
        name: zoneForm.name.trim(),
        description: zoneForm.description.trim() || null,
        baseFee: Number.parseFloat(zoneForm.baseFee) || 0,
        perPieceFee: Number.parseFloat(zoneForm.perPieceFee) || 0,
        isThirdParty: zoneForm.isThirdParty,
        carrierName: zoneForm.isThirdParty ? zoneForm.carrierName.trim() || null : null,
        isActive: zoneForm.isActive,
      };
      if (zoneModal?.editing) {
        await axios.put(`/api/service/delivery-zones/${zoneModal.editing.id}`, payload);
      } else {
        await axios.post("/api/service/delivery-zones", payload);
      }
      setZoneModal(null);
      toast.success("Delivery zone saved");
      await loadZones();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save zone"));
    } finally {
      setZoneSaving(false);
    }
  };

  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;

  if (loading) {
    return <p className="text-sh-gray py-8">Loading...</p>;
  }

  return (
    <>
      <div className="py-2 space-y-6 font-serif">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl text-sh-blue font-semibold">Delivery Zones</h1>
          <Button variant="primary" onClick={() => openZoneModal(null)}>
            Add Zone
          </Button>
        </div>

        {/* Zones Table */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Name</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Description</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[100px]">
                  Base Fee
                </th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[110px]">
                  Per-Piece
                </th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[130px]">
                  Third Party
                </th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[80px]">ZIPs</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[80px]">Active</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[120px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {zones.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sh-gray">
                    No delivery zones configured
                  </td>
                </tr>
              ) : (
                zones.map((zone) => (
                  <ZoneRow
                    key={zone.id}
                    zone={zone}
                    selected={selectedZoneId === zone.id}
                    onSelect={() => setSelectedZoneId(selectedZoneId === zone.id ? null : zone.id)}
                    onEdit={() => openZoneModal(zone)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ZIP Management (shown when a zone is selected) */}
        {selectedZone && (
          <ZipManagementPanel key={selectedZone.id} zone={selectedZone} onZipsChanged={loadZones} />
        )}
      </div>

      {/* Zone Modal */}
      {zoneModal && (
        <Modal
          title={zoneModal.editing ? "Edit Delivery Zone" : "Add Delivery Zone"}
          onClose={() => setZoneModal(null)}
          onSave={saveZone}
          saving={zoneSaving}
        >
          <FormInput
            label="Name"
            name="zoneName"
            value={zoneForm.name}
            onChange={(v) => setZoneForm((f) => ({ ...f, name: v }))}
            required
          />
          <FormInput
            label="Description"
            name="zoneDescription"
            value={zoneForm.description}
            onChange={(v) => setZoneForm((f) => ({ ...f, description: v }))}
          />
          <div className="grid grid-cols-2 gap-4">
            <FormInput
              label="Base Fee ($)"
              name="zoneBaseFee"
              type="number"
              value={zoneForm.baseFee}
              onChange={(v) => setZoneForm((f) => ({ ...f, baseFee: v }))}
            />
            <FormInput
              label="Per-Piece Fee ($)"
              name="zonePerPieceFee"
              type="number"
              value={zoneForm.perPieceFee}
              onChange={(v) => setZoneForm((f) => ({ ...f, perPieceFee: v }))}
            />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              id="zoneThirdParty"
              checked={zoneForm.isThirdParty}
              onChange={(e) => setZoneForm((f) => ({ ...f, isThirdParty: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="zoneThirdParty" className="text-sm text-sh-gray">
              Third-party carrier
            </label>
          </div>
          {zoneForm.isThirdParty && (
            <FormInput
              label="Carrier Name"
              name="zoneCarrierName"
              value={zoneForm.carrierName}
              onChange={(v) => setZoneForm((f) => ({ ...f, carrierName: v }))}
            />
          )}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="zoneActive"
              checked={zoneForm.isActive}
              onChange={(e) => setZoneForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="zoneActive" className="text-sm text-sh-gray">
              Active
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
