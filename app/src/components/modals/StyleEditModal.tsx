// /app/src/components/modals/StyleEditModal.tsx
//
// Full-screen edit modal for VendorStyle records. Allows manual correction
// of imported data: image, dimensions, construction, yardage, and options.

import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog, DialogPanel, DialogTitle, DialogBackdrop } from "@headlessui/react";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { Loader2, Upload, X, Check, ChevronDown, ChevronRight, Trash2 } from "lucide-react";

interface VendorOption {
  id: number;
  name: string;
  code: string | null;
  surchargeType: string;
  defaultSurcharge: number | string;
  sortOrder: number;
}

interface VendorOptionGroup {
  id: number;
  name: string;
  options: VendorOption[];
}

interface OptionOverride {
  optionId: number;
  surcharge: number | null;
  isAvailable: boolean;
  isStandard: boolean;
  notes: string | null;
  option: {
    id: number;
    name: string;
    surchargeType: string;
    defaultSurcharge: number | string;
    group: { id: number; name: string };
  };
}

interface StyleData {
  id: number;
  styleNumber: string;
  name: string;
  description: string | null;
  baseCost: string | number | null;
  baseRetail: string | number | null;
  mapPrice: string | number | null;
  comYardage: string | number | null;
  comYardagePattern: string | number | null;
  comYardageRepeat: string | number | null;
  gradeRiser: string | number | null;
  standardSeat: string | null;
  standardBack: string | null;
  standardPillows: string | null;
  finish: string | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  seatHeight: number | null;
  armHeight: number | null;
  seatDepth: number | null;
  imageUrl: string | null;
  vendor: { id: number; name: string };
  optionOverrides: OptionOverride[];
}

interface Props {
  styleId: number;
  onClose: () => void;
  onSaved: () => void;
}

// Per-option form state
interface OptionFormState {
  surcharge: string;
  isAvailable: boolean;
  isStandard: boolean;
  notes: string;
}

export default function StyleEditModal({ styleId, onClose, onSaved }: Props) {
  const [style, setStyle] = useState<StyleData | null>(null);
  const [vendorOptionGroups, setVendorOptionGroups] = useState<VendorOptionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Expanded sections (all expanded by default)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    details: true,
    dimensions: true,
    construction: true,
    yardage: true,
    options: true,
  });

  // Field form state
  const [fields, setFields] = useState({
    name: "",
    description: "",
    width: "",
    depth: "",
    height: "",
    seatHeight: "",
    armHeight: "",
    seatDepth: "",
    standardSeat: "",
    standardBack: "",
    standardPillows: "",
    finish: "",
    baseCost: "",
    baseRetail: "",
    mapPrice: "",
    comYardage: "",
    comYardagePattern: "",
    comYardageRepeat: "",
    gradeRiser: "",
  });

  // Option overrides form state, keyed by optionId
  const [optionForms, setOptionForms] = useState<Record<number, OptionFormState>>({});

  const fetchStyle = useCallback(async () => {
    try {
      const res = await fetch(`/api/pricing/styles/${styleId}`);
      if (!res.ok) {
        toast.error("Failed to load style");
        onClose();
        return;
      }
      const data = await res.json();
      setStyle(data.style);
      setVendorOptionGroups(data.vendorOptionGroups || []);
      populateForm(data.style, data.vendorOptionGroups || []);
    } catch {
      toast.error("Failed to load style");
      onClose();
    } finally {
      setLoading(false);
    }
  }, [styleId, onClose]);

  useEffect(() => {
    fetchStyle();
  }, [fetchStyle]);

  function populateForm(s: StyleData, groups: VendorOptionGroup[]) {
    setFields({
      name: s.name || "",
      description: s.description || "",
      width: s.width != null ? String(s.width) : "",
      depth: s.depth != null ? String(s.depth) : "",
      height: s.height != null ? String(s.height) : "",
      seatHeight: s.seatHeight != null ? String(s.seatHeight) : "",
      armHeight: s.armHeight != null ? String(s.armHeight) : "",
      seatDepth: s.seatDepth != null ? String(s.seatDepth) : "",
      standardSeat: s.standardSeat || "",
      standardBack: s.standardBack || "",
      standardPillows: s.standardPillows || "",
      finish: s.finish || "",
      baseCost: s.baseCost != null ? String(s.baseCost) : "",
      baseRetail: s.baseRetail != null ? String(s.baseRetail) : "",
      mapPrice: s.mapPrice != null ? String(s.mapPrice) : "",
      comYardage: s.comYardage != null ? String(s.comYardage) : "",
      comYardagePattern: s.comYardagePattern != null ? String(s.comYardagePattern) : "",
      comYardageRepeat: s.comYardageRepeat != null ? String(s.comYardageRepeat) : "",
      gradeRiser: s.gradeRiser != null ? String(s.gradeRiser) : "",
    });

    // Build option form state from existing overrides + vendor defaults
    const overrideMap = new Map(s.optionOverrides.map((o) => [o.optionId, o]));
    const forms: Record<number, OptionFormState> = {};

    for (const group of groups) {
      for (const opt of group.options) {
        const override = overrideMap.get(opt.id);
        forms[opt.id] = {
          surcharge: override?.surcharge != null ? String(override.surcharge) : "",
          isAvailable: override?.isAvailable ?? true,
          isStandard: override?.isStandard ?? false,
          notes: override?.notes || "",
        };
      }
    }
    setOptionForms(forms);
  }

  function handleFieldChange(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleOptionChange(optionId: number, key: keyof OptionFormState, value: unknown) {
    setOptionForms((prev) => ({
      ...prev,
      [optionId]: { ...prev[optionId], [key]: value },
    }));
  }

  function toggleSection(section: string) {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Build option overrides array
      const overrides = Object.entries(optionForms).map(([optionIdStr, form]) => ({
        optionId: Number.parseInt(optionIdStr),
        surcharge: form.surcharge !== "" ? Number.parseFloat(form.surcharge) : null,
        isAvailable: form.isAvailable,
        isStandard: form.isStandard,
        notes: form.notes || null,
      }));

      const res = await fetch(`/api/pricing/styles/${styleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, optionOverrides: overrides }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Save failed");
        return;
      }

      toast.success("Style updated");
      onSaved();
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleImageUpload(file: File) {
    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/pricing/styles/${styleId}/image`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Image upload failed");
        return;
      }

      const { imageUrl } = await res.json();
      setStyle((prev) => (prev ? { ...prev, imageUrl } : prev));
      toast.success("Image updated");
    } catch {
      toast.error("Image upload failed");
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleRemoveImage() {
    setUploadingImage(true);
    try {
      const res = await fetch(`/api/pricing/styles/${styleId}/image`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Image removal failed");
        return;
      }
      setStyle((prev) => (prev ? { ...prev, imageUrl: null } : prev));
      toast.success("Image removed");
    } catch {
      toast.error("Image removal failed");
    } finally {
      setUploadingImage(false);
    }
  }

  const SectionHeader = ({ label, section }: { label: string; section: string }) => (
    <button
      type="button"
      onClick={() => toggleSection(section)}
      className="flex items-center gap-2 w-full text-left py-2 text-sm font-semibold text-sh-blue uppercase tracking-wider"
    >
      {expandedSections[section] ? (
        <ChevronDown className="w-4 h-4" />
      ) : (
        <ChevronRight className="w-4 h-4" />
      )}
      {label}
    </button>
  );

  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-black/50 duration-300 ease-out data-closed:opacity-0"
      />

      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel
            transition
            className="w-full max-w-3xl transform overflow-hidden rounded-2xl bg-white text-left shadow-xl transition-all font-serif duration-300 ease-out data-closed:scale-95 data-closed:opacity-0"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-sh-gray/20">
              <DialogTitle as="h3" className="text-xl font-semibold text-sh-blue">
                {style ? `${style.styleNumber} - ${style.name}` : "Loading..."}
              </DialogTitle>
              <button onClick={onClose} className="text-sh-gray hover:text-sh-black transition p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 text-sh-blue animate-spin" />
              </div>
            ) : (
              style && (
                <>
                  {/* Scrollable body */}
                  <div className="px-6 py-4 max-h-[70vh] overflow-y-auto space-y-4">
                    {/* Image section */}
                    <div className="flex gap-4 items-start">
                      <div className="w-32 h-32 flex-shrink-0 rounded-lg border border-sh-gray/20 overflow-hidden bg-sh-linen flex items-center justify-center">
                        {style.imageUrl ? (
                          <img
                            src={style.imageUrl}
                            alt={style.styleNumber}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <span className="text-sh-gray text-xs text-center px-2">No image</span>
                        )}
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs text-sh-gray">
                          {style.imageUrl || "No image assigned"}
                        </p>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleImageUpload(file);
                          }}
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploadingImage}
                          >
                            {uploadingImage ? (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            ) : (
                              <Upload className="w-3 h-3 mr-1" />
                            )}
                            Replace Image
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRemoveImage}
                            disabled={uploadingImage || !style.imageUrl}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Remove Image
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Details */}
                    <div>
                      <SectionHeader label="Details" section="details" />
                      {expandedSections.details && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-2">
                          <FieldRow label="Style Number">
                            <div className="px-3 py-2 bg-sh-linen rounded-lg text-sh-black text-sm">
                              {style.styleNumber}
                            </div>
                          </FieldRow>
                          <FieldRow label="Name">
                            <input
                              type="text"
                              value={fields.name}
                              onChange={(e) => handleFieldChange("name", e.target.value)}
                              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black"
                            />
                          </FieldRow>
                          <div className="md:col-span-2">
                            <FieldRow label="Description">
                              <textarea
                                value={fields.description}
                                onChange={(e) => handleFieldChange("description", e.target.value)}
                                rows={2}
                                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black resize-none"
                              />
                            </FieldRow>
                          </div>
                          <FieldRow label="Base Cost">
                            <NumericInput
                              value={fields.baseCost}
                              onChange={(v) => handleFieldChange("baseCost", v)}
                              prefix="$"
                            />
                          </FieldRow>
                          <FieldRow label="Base Retail">
                            <NumericInput
                              value={fields.baseRetail}
                              onChange={(v) => handleFieldChange("baseRetail", v)}
                              prefix="$"
                            />
                          </FieldRow>
                          <FieldRow label="MAP Price">
                            <NumericInput
                              value={fields.mapPrice}
                              onChange={(v) => handleFieldChange("mapPrice", v)}
                              prefix="$"
                            />
                          </FieldRow>
                          <FieldRow label="Grade Riser">
                            <NumericInput
                              value={fields.gradeRiser}
                              onChange={(v) => handleFieldChange("gradeRiser", v)}
                              prefix="$"
                            />
                          </FieldRow>
                        </div>
                      )}
                    </div>

                    {/* Dimensions */}
                    <div>
                      <SectionHeader label="Dimensions" section="dimensions" />
                      {expandedSections.dimensions && (
                        <div className="grid grid-cols-3 gap-3 pb-2">
                          <FieldRow label="Width">
                            <NumericInput
                              value={fields.width}
                              onChange={(v) => handleFieldChange("width", v)}
                              suffix='"'
                            />
                          </FieldRow>
                          <FieldRow label="Depth">
                            <NumericInput
                              value={fields.depth}
                              onChange={(v) => handleFieldChange("depth", v)}
                              suffix='"'
                            />
                          </FieldRow>
                          <FieldRow label="Height">
                            <NumericInput
                              value={fields.height}
                              onChange={(v) => handleFieldChange("height", v)}
                              suffix='"'
                            />
                          </FieldRow>
                          <FieldRow label="Seat Height">
                            <NumericInput
                              value={fields.seatHeight}
                              onChange={(v) => handleFieldChange("seatHeight", v)}
                              suffix='"'
                            />
                          </FieldRow>
                          <FieldRow label="Arm Height">
                            <NumericInput
                              value={fields.armHeight}
                              onChange={(v) => handleFieldChange("armHeight", v)}
                              suffix='"'
                            />
                          </FieldRow>
                          <FieldRow label="Seat Depth">
                            <NumericInput
                              value={fields.seatDepth}
                              onChange={(v) => handleFieldChange("seatDepth", v)}
                              suffix='"'
                            />
                          </FieldRow>
                        </div>
                      )}
                    </div>

                    {/* Construction */}
                    <div>
                      <SectionHeader label="Construction" section="construction" />
                      {expandedSections.construction && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-2">
                          <FieldRow label="Standard Seat">
                            <input
                              type="text"
                              value={fields.standardSeat}
                              onChange={(e) => handleFieldChange("standardSeat", e.target.value)}
                              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black"
                            />
                          </FieldRow>
                          <FieldRow label="Standard Back">
                            <input
                              type="text"
                              value={fields.standardBack}
                              onChange={(e) => handleFieldChange("standardBack", e.target.value)}
                              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black"
                            />
                          </FieldRow>
                          <FieldRow label="Standard Pillows">
                            <input
                              type="text"
                              value={fields.standardPillows}
                              onChange={(e) => handleFieldChange("standardPillows", e.target.value)}
                              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black"
                            />
                          </FieldRow>
                          <FieldRow label="Finish">
                            <input
                              type="text"
                              value={fields.finish}
                              onChange={(e) => handleFieldChange("finish", e.target.value)}
                              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black"
                            />
                          </FieldRow>
                        </div>
                      )}
                    </div>

                    {/* Yardage */}
                    <div>
                      <SectionHeader label="COM Yardage" section="yardage" />
                      {expandedSections.yardage && (
                        <div className="grid grid-cols-3 gap-3 pb-2">
                          <FieldRow label='Plain (54")'>
                            <NumericInput
                              value={fields.comYardage}
                              onChange={(v) => handleFieldChange("comYardage", v)}
                              suffix=" yds"
                            />
                          </FieldRow>
                          <FieldRow label="Pattern">
                            <NumericInput
                              value={fields.comYardagePattern}
                              onChange={(v) => handleFieldChange("comYardagePattern", v)}
                              suffix=" yds"
                            />
                          </FieldRow>
                          <FieldRow label="Repeat">
                            <NumericInput
                              value={fields.comYardageRepeat}
                              onChange={(v) => handleFieldChange("comYardageRepeat", v)}
                              suffix=" yds"
                            />
                          </FieldRow>
                        </div>
                      )}
                    </div>

                    {/* Options */}
                    <div>
                      <SectionHeader label="Options" section="options" />
                      {expandedSections.options && (
                        <div className="space-y-4 pb-2">
                          {vendorOptionGroups.map((group) => (
                            <div key={group.id}>
                              <h4 className="text-xs font-semibold text-sh-gray uppercase tracking-wider mb-2">
                                {group.name}
                              </h4>
                              <div className="border border-sh-gray/20 rounded-lg overflow-hidden">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="bg-sh-linen text-sh-gray text-xs">
                                      <th className="text-left px-3 py-2 font-medium">Option</th>
                                      <th className="text-center px-3 py-2 font-medium w-20">
                                        Available
                                      </th>
                                      <th className="text-center px-3 py-2 font-medium w-20">
                                        Included
                                      </th>
                                      <th className="text-right px-3 py-2 font-medium w-24">
                                        Surcharge
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {group.options.map((opt) => {
                                      const form = optionForms[opt.id];
                                      if (!form) return null;
                                      return (
                                        <tr
                                          key={opt.id}
                                          className="border-t border-sh-gray/10 hover:bg-sh-linen/30"
                                        >
                                          <td className="px-3 py-2 text-sh-black">{opt.name}</td>
                                          <td className="px-3 py-2 text-center">
                                            <input
                                              type="checkbox"
                                              checked={form.isAvailable}
                                              onChange={(e) =>
                                                handleOptionChange(
                                                  opt.id,
                                                  "isAvailable",
                                                  e.target.checked,
                                                )
                                              }
                                              className="h-4 w-4 accent-sh-blue"
                                            />
                                          </td>
                                          <td className="px-3 py-2 text-center">
                                            <input
                                              type="checkbox"
                                              checked={form.isStandard}
                                              onChange={(e) =>
                                                handleOptionChange(
                                                  opt.id,
                                                  "isStandard",
                                                  e.target.checked,
                                                )
                                              }
                                              className="h-4 w-4 accent-sh-blue"
                                            />
                                          </td>
                                          <td className="px-3 py-2">
                                            <div className="flex items-center justify-end">
                                              <span className="text-sh-gray text-xs mr-1">$</span>
                                              <input
                                                type="number"
                                                value={form.surcharge}
                                                onChange={(e) =>
                                                  handleOptionChange(
                                                    opt.id,
                                                    "surcharge",
                                                    e.target.value,
                                                  )
                                                }
                                                placeholder={String(
                                                  Number(opt.defaultSurcharge) || 0,
                                                )}
                                                className="w-16 text-right border border-sh-gray/30 rounded px-2 py-1 text-sm text-sh-black"
                                              />
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-sh-gray/20 bg-sh-linen/30">
                    <Button variant="secondary" onClick={onClose}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={handleSave} disabled={saving}>
                      {saving ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Check className="w-4 h-4 mr-2" />
                          Save Changes
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

// Compact field row for the edit form
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-sh-gray mb-1">{label}</label>
      {children}
    </div>
  );
}

// Numeric input with optional prefix/suffix display
function NumericInput({
  value,
  onChange,
  prefix,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-center border border-sh-gray/30 rounded-lg overflow-hidden">
      {prefix && (
        <span className="px-2 text-sm text-sh-gray bg-sh-linen border-r border-sh-gray/30">
          {prefix}
        </span>
      )}
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-3 py-2 text-sm text-sh-black min-w-0"
      />
      {suffix && (
        <span className="px-2 text-sm text-sh-gray bg-sh-linen border-l border-sh-gray/30">
          {suffix}
        </span>
      )}
    </div>
  );
}
