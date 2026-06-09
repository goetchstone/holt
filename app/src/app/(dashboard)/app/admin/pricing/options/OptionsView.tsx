"use client";

// /app/src/app/(dashboard)/app/admin/pricing/options/OptionsView.tsx
//
// Manage vendor option groups + options body. App Router port of the legacy
// admin/pricing/options body (minus MainLayout chrome, which the (dashboard)
// layout supplies). Pick a vendor, then create/edit/delete option groups and
// their surcharges. All mutations go through the shared POST/PATCH/DELETE
// /api/pricing/options REST endpoint, which stays REST.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";
import axios from "axios";
import { ChevronDown, ChevronRight, Plus, Pencil, Trash2, Save, X, Loader2 } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────

interface VendorOption {
  id: number;
  name: string;
  surchargeType: string;
  defaultSurcharge: number;
  sortOrder: number;
}

interface VendorOptionGroup {
  id: number;
  name: string;
  description: string | null;
  options: VendorOption[];
}

interface Vendor {
  id: number;
  name: string;
}

interface EditForm {
  name: string;
  surchargeType: string;
  defaultSurcharge: number;
}

// ─── Pure helpers ──────────────────────────────────────────────────

function surchargeLabel(type: string): string {
  if (type === "PER_UNIT") return "/unit";
  if (type === "PERCENTAGE") return "%";
  return "flat";
}

const SURCHARGE_TYPES = [
  { value: "FLAT", label: "Flat ($)" },
  { value: "PER_UNIT", label: "Per Unit" },
  { value: "PERCENTAGE", label: "Percentage" },
] as const;

// ─── Sub-components ─────────────────────────────────────────────────

function OptionEditRow({
  editForm,
  onChange,
  onSave,
  onCancel,
}: Readonly<{
  editForm: EditForm;
  onChange: (form: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
}>) {
  return (
    <>
      <td className="py-2 pr-2">
        <input
          aria-label="Option name"
          value={editForm.name}
          onChange={(e) => onChange({ ...editForm, name: e.target.value })}
          className="w-full border border-sh-gray/40 rounded px-2 py-1 text-sm"
        />
      </td>
      <td className="py-2 pr-2">
        <select
          aria-label="Surcharge type"
          value={editForm.surchargeType}
          onChange={(e) => onChange({ ...editForm, surchargeType: e.target.value })}
          className="w-full border border-sh-gray/40 rounded px-2 py-1 text-sm bg-white"
        >
          {SURCHARGE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label="Surcharge amount"
          type="number"
          value={editForm.defaultSurcharge}
          onChange={(e) =>
            onChange({ ...editForm, defaultSurcharge: Number.parseFloat(e.target.value) || 0 })
          }
          className="w-full border border-sh-gray/40 rounded px-2 py-1 text-sm text-right"
        />
      </td>
      <td className="py-2 text-right">
        <div className="flex gap-1 justify-end">
          <button
            type="button"
            onClick={onSave}
            className="text-green-600 hover:text-green-800 p-1"
            aria-label="Save option"
          >
            <Save className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-sh-gray hover:text-sh-black p-1"
            aria-label="Cancel edit"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </>
  );
}

function OptionDisplayRow({
  opt,
  onEdit,
  onDelete,
}: Readonly<{
  opt: VendorOption;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  return (
    <>
      <td className="py-2 text-sh-black">{opt.name}</td>
      <td className="py-2 text-sh-gray text-xs uppercase">{opt.surchargeType}</td>
      <td className="py-2 text-right text-sh-blue font-medium">
        ${opt.defaultSurcharge.toFixed(0)}
        <span className="text-xs text-sh-gray ml-1">{surchargeLabel(opt.surchargeType)}</span>
      </td>
      <td className="py-2 text-right">
        <div className="flex gap-1 justify-end">
          <button
            type="button"
            onClick={onEdit}
            className="text-sh-gray hover:text-sh-blue p-1"
            aria-label={`Edit ${opt.name}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-red-400 hover:text-red-600 p-1"
            aria-label={`Delete ${opt.name}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </>
  );
}

function NewOptionForm({
  name,
  type,
  surcharge,
  onNameChange,
  onTypeChange,
  onSurchargeChange,
  onAdd,
  onCancel,
}: Readonly<{
  name: string;
  type: string;
  surcharge: number;
  onNameChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onSurchargeChange: (value: number) => void;
  onAdd: () => void;
  onCancel: () => void;
}>) {
  return (
    <div className="mt-3 flex items-end gap-2 bg-sh-linen/50 rounded-lg p-3">
      <div className="flex-1">
        <label htmlFor="new-opt-name" className="block text-xs text-sh-gray mb-1">
          Name
        </label>
        <input
          id="new-opt-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Contrast Piping"
          className="w-full border border-sh-gray/40 rounded px-2 py-1 text-sm"
          autoFocus
        />
      </div>
      <div className="w-32">
        <label htmlFor="new-opt-type" className="block text-xs text-sh-gray mb-1">
          Type
        </label>
        <select
          id="new-opt-type"
          value={type}
          onChange={(e) => onTypeChange(e.target.value)}
          className="w-full border border-sh-gray/40 rounded px-2 py-1 text-sm bg-white"
        >
          {SURCHARGE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="w-24">
        <label htmlFor="new-opt-surcharge" className="block text-xs text-sh-gray mb-1">
          Surcharge
        </label>
        <input
          id="new-opt-surcharge"
          type="number"
          value={surcharge}
          onChange={(e) => onSurchargeChange(Number.parseFloat(e.target.value) || 0)}
          className="w-full border border-sh-gray/40 rounded px-2 py-1 text-sm text-right"
        />
      </div>
      <Button size="sm" onClick={onAdd}>
        <Save className="w-3.5 h-3.5 mr-1" /> Add
      </Button>
      <button
        type="button"
        onClick={onCancel}
        className="text-sh-gray hover:text-sh-black p-1"
        aria-label="Cancel new option"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

export function OptionsView() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [groups, setGroups] = useState<VendorOptionGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  // Inline editing state
  const [editingOption, setEditingOption] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    name: "",
    surchargeType: "FLAT",
    defaultSurcharge: 0,
  });

  // New group form
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");

  // New option form (per group)
  const [addingOptionToGroup, setAddingOptionToGroup] = useState<number | null>(null);
  const [newOptName, setNewOptName] = useState("");
  const [newOptType, setNewOptType] = useState("FLAT");
  const [newOptSurcharge, setNewOptSurcharge] = useState(0);

  // Load vendors
  const loadVendors = useCallback(async () => {
    try {
      const res = await axios.get("/api/vendors?all=true");
      const list: Vendor[] = res.data.vendors || res.data || [];
      setVendors(list);
      const wh = list.find((v) => v.name.toLowerCase().includes("wesley hall"));
      if (wh) setSelectedVendorId(wh.id);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load vendors"));
    }
  }, []);

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  // Load options when vendor changes
  const loadOptions = useCallback(async () => {
    if (!selectedVendorId) return;
    setLoading(true);
    try {
      const res = await axios.get(`/api/pricing/options?vendorId=${selectedVendorId}`);
      const loaded: VendorOptionGroup[] = res.data.groups || [];
      setGroups(loaded);
      // Expand all groups by default
      setExpandedGroups(new Set(loaded.map((g) => g.id)));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load options"));
    } finally {
      setLoading(false);
    }
  }, [selectedVendorId]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const toggleGroup = (id: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createGroup = useCallback(async () => {
    if (!newGroupName.trim() || !selectedVendorId) return;
    try {
      await axios.post("/api/pricing/options", {
        action: "createGroup",
        vendorId: selectedVendorId,
        name: newGroupName.trim(),
        description: newGroupDesc.trim() || null,
      });
      toast.success("Group created");
      setNewGroupName("");
      setNewGroupDesc("");
      setShowNewGroup(false);
      loadOptions();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create group"));
    }
  }, [newGroupName, newGroupDesc, selectedVendorId, loadOptions]);

  const createOption = useCallback(
    async (groupId: number) => {
      if (!newOptName.trim()) return;
      try {
        await axios.post("/api/pricing/options", {
          action: "createOption",
          groupId,
          name: newOptName.trim(),
          surchargeType: newOptType,
          defaultSurcharge: newOptSurcharge,
        });
        toast.success("Option added");
        setAddingOptionToGroup(null);
        setNewOptName("");
        setNewOptType("FLAT");
        setNewOptSurcharge(0);
        loadOptions();
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Failed to create option"));
      }
    },
    [newOptName, newOptType, newOptSurcharge, loadOptions],
  );

  const updateOption = useCallback(
    async (id: number) => {
      try {
        await axios.patch("/api/pricing/options", {
          action: "updateOption",
          id,
          name: editForm.name,
          surchargeType: editForm.surchargeType,
          defaultSurcharge: editForm.defaultSurcharge,
        });
        toast.success("Option updated");
        setEditingOption(null);
        loadOptions();
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Failed to update option"));
      }
    },
    [editForm, loadOptions],
  );

  const deleteOption = useCallback(
    async (id: number, name: string) => {
      if (!confirm(`Delete option "${name}"? This will also remove any per-product overrides.`))
        return;
      try {
        await axios.delete("/api/pricing/options", { data: { action: "deleteOption", id } });
        toast.success("Option deleted");
        loadOptions();
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Failed to delete option"));
      }
    },
    [loadOptions],
  );

  const deleteGroup = useCallback(
    async (id: number, name: string) => {
      if (!confirm(`Delete group "${name}" and all its options? This cannot be undone.`)) return;
      try {
        await axios.delete("/api/pricing/options", { data: { action: "deleteGroup", id } });
        toast.success("Group deleted");
        loadOptions();
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Failed to delete group"));
      }
    },
    [loadOptions],
  );

  const startEdit = (opt: VendorOption) => {
    setEditingOption(opt.id);
    setEditForm({
      name: opt.name,
      surchargeType: opt.surchargeType,
      defaultSurcharge: opt.defaultSurcharge,
    });
  };

  const startAddOption = (groupId: number) => {
    setAddingOptionToGroup(groupId);
    setNewOptName("");
    setNewOptType("FLAT");
    setNewOptSurcharge(0);
  };

  return (
    <div className="py-2 font-serif space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue mb-1">Manage Vendor Options</h1>
        <p className="text-sh-gray text-sm">
          Add, edit, or remove option groups and surcharges for a vendor.
        </p>
      </div>

      {/* Vendor selector */}
      <div className="max-w-xs">
        <label htmlFor="opt-vendor" className="block text-sm font-semibold text-sh-blue mb-1">
          Vendor
        </label>
        <select
          id="opt-vendor"
          value={selectedVendorId ?? ""}
          onChange={(e) => setSelectedVendorId(Number(e.target.value) || null)}
          className="w-full border border-sh-gray rounded-lg px-3 py-2 text-sh-black font-serif bg-white"
        >
          <option value="">Select a vendor…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sh-gray text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading options…
        </div>
      )}

      {!loading && selectedVendorId && (
        <>
          {/* Option groups */}
          <div className="space-y-3">
            {groups.map((group) => (
              <div
                key={group.id}
                className="bg-white border border-sh-gray/20 rounded-lg shadow-sm"
              >
                {/* Group header */}
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-sh-linen/50 transition"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGroup(group.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleGroup(group.id);
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    {expandedGroups.has(group.id) ? (
                      <ChevronDown className="w-4 h-4 text-sh-gray" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-sh-gray" />
                    )}
                    <span className="font-semibold text-sh-blue">{group.name}</span>
                    <span className="text-xs text-sh-gray ml-2">
                      {group.options.length} option{group.options.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteGroup(group.id, group.name);
                    }}
                    className="text-red-400 hover:text-red-600 p-1"
                    aria-label={`Delete group ${group.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Expanded options */}
                {expandedGroups.has(group.id) && (
                  <div className="border-t border-sh-gray/10 px-4 pb-3">
                    {group.description && (
                      <p className="text-xs text-sh-gray mt-2 mb-2">{group.description}</p>
                    )}

                    {/* Options table */}
                    <table className="w-full text-sm mt-2">
                      <thead>
                        <tr className="text-xs text-sh-gray uppercase tracking-wider border-b border-sh-gray/10">
                          <th className="text-left py-1 font-normal">Option</th>
                          <th className="text-left py-1 font-normal w-32">Type</th>
                          <th className="text-right py-1 font-normal w-28">Surcharge</th>
                          <th className="text-right py-1 font-normal w-20" aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {group.options.map((opt) => (
                          <tr key={opt.id} className="border-b border-sh-gray/5 last:border-0">
                            {editingOption === opt.id ? (
                              <OptionEditRow
                                editForm={editForm}
                                onChange={setEditForm}
                                onSave={() => updateOption(opt.id)}
                                onCancel={() => setEditingOption(null)}
                              />
                            ) : (
                              <OptionDisplayRow
                                opt={opt}
                                onEdit={() => startEdit(opt)}
                                onDelete={() => deleteOption(opt.id, opt.name)}
                              />
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Add option to this group */}
                    {addingOptionToGroup === group.id ? (
                      <NewOptionForm
                        name={newOptName}
                        type={newOptType}
                        surcharge={newOptSurcharge}
                        onNameChange={setNewOptName}
                        onTypeChange={setNewOptType}
                        onSurchargeChange={setNewOptSurcharge}
                        onAdd={() => createOption(group.id)}
                        onCancel={() => setAddingOptionToGroup(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startAddOption(group.id)}
                        className="mt-3 text-xs text-sh-blue hover:text-sh-black flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add option
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {groups.length === 0 && !loading && (
            <p className="text-sh-gray text-sm">No option groups for this vendor yet.</p>
          )}

          {/* New group form */}
          {showNewGroup ? (
            <div className="bg-sh-linen/50 border border-sh-gray/20 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-sh-blue">New Option Group</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="new-group-name" className="block text-xs text-sh-gray mb-1">
                    Group Name
                  </label>
                  <input
                    id="new-group-name"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="e.g. Wood Finish Options"
                    className="w-full border border-sh-gray/40 rounded-lg px-3 py-2 text-sm"
                    autoFocus
                  />
                </div>
                <div>
                  <label htmlFor="new-group-desc" className="block text-xs text-sh-gray mb-1">
                    Description (optional)
                  </label>
                  <input
                    id="new-group-desc"
                    value={newGroupDesc}
                    onChange={(e) => setNewGroupDesc(e.target.value)}
                    placeholder="e.g. Available wood finishes and stains"
                    className="w-full border border-sh-gray/40 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={createGroup}>
                  <Save className="w-3.5 h-3.5 mr-1" /> Create Group
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setShowNewGroup(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setShowNewGroup(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Option Group
            </Button>
          )}
        </>
      )}
    </div>
  );
}
