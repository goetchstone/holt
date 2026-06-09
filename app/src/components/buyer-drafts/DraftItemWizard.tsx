// /app/src/components/buyer-drafts/DraftItemWizard.tsx
//
// Wizard modal for creating / editing a buyer draft item. Walks the buyer
// through 7 steps with Back / Next / Save buttons and a sticky tab bar so
// they can jump back to a step. Sticky defaults (vendor, dept, cat,
// stocking program flag, stock location) come from
// `useStickyDraftDefaults` so a batch of items from one supplier doesn't
// re-pick the same dropdowns 30 times.
//
// On save, two terminal actions:
//   - "Save" → close the modal
//   - "Save and add another" → reset per-item fields (part #, name,
//     description, pricing, dimensions) and stay on step 1 with sticky
//     fields preserved. This is the buyer's batch loop.

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Dialog, DialogPanel, DialogBackdrop, DialogTitle } from "@headlessui/react";
import {
  Building2,
  Tag,
  Layers,
  FileText,
  DollarSign,
  Package,
  Check,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  PlusCircle,
  Search,
  Palette,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { useStickyDraftDefaults, type DraftDefaults } from "@/hooks/useStickyDraftDefaults";
import {
  assembleDescription,
  assembleDescriptionForExport,
  CLEANING_CODE_PRESETS,
} from "@/lib/buyerDraftRequestBody";
import VendorStylePickerModal from "@/components/buyer-drafts/VendorStylePickerModal";

// ─── Lookup shapes (subset of the page's lookups payload) ─────────────

interface Vendor {
  id: number;
  name: string;
  code: string | null;
}
interface Department {
  id: number;
  name: string;
}
interface Category {
  id: number;
  name: string;
  departmentId: number;
}
interface Type {
  id: number;
  name: string;
  categoryId: number;
}
interface StockLocation {
  id: number;
  code: string;
  name: string;
}
interface DraftPo {
  id: number;
  vendorName: string;
  referenceNumber: string | null;
  vendor?: { id: number; name: string } | null;
}

// ─── Form state ────────────────────────────────────────────────────────

interface ItemFormState {
  // Vendor
  vendorId: number | null;
  vendorName: string; // typed when no FK selected (new vendor in flight)
  // Identity
  partNumber: string;
  productName: string;
  draftPoId: number | null;
  // Taxonomy
  departmentId: number | null;
  categoryId: number | null;
  typeId: number | null;
  // Configurator-style structured fields (slice 4a + 4-lite-v2)
  itemType: "UPHOLSTERY" | "CASE_GOODS" | "OTHER";
  grade: string; // upholstery: "13" / "C"; case goods: wood species
  fabric: string;
  finish: string;
  cushions: string;
  cleaningCode: string;
  tossPillows: string;
  hardware: string;
  hardwareFinish: string;
  options: string;
  // Description — auto-assembled from structured fields when descriptionMode
  // is "auto"; free-text when "manual" (the buyer hit "override").
  description: string;
  descriptionMode: "auto" | "manual";
  // Pricing
  cost: string;
  msrp: string;
  retail: string;
  qty: string;
  // Dimensions (inches)
  productWidth: string;
  productLength: string;
  productHeight: string;
  // Stocking & location
  stockProgram: boolean;
  stockFamily: string;
  stockLocationId: number | null;
  vignette: string;
  // Misc
  notes: string;
  status: "DRAFT" | "READY";
  // Catalog linkage (slice 4-lite). Populated when the buyer pre-fills
  // from a VendorStyle via the Pick from catalog button. Source defaults
  // to MANUAL; the picker flips it to CONFIGURATOR.
  vendorStyleId: number | null;
  source: "MANUAL" | "HD_PROPOSAL" | "APPAREL_SCAN" | "CONFIGURATOR";
}

// Step order updated 2026-05-09 per buyer feedback: configure A (textile
// + grade + finish + cleaning) → configure B (dimensions + options +
// description preview with carriage returns) → pricing → stocking. The
// standalone Dimensions step folds into configure-b.
const STEPS = [
  { id: "vendor", label: "Vendor", icon: <Building2 className="h-4 w-4" /> },
  { id: "identity", label: "Identity", icon: <Tag className="h-4 w-4" /> },
  { id: "taxonomy", label: "Taxonomy", icon: <Layers className="h-4 w-4" /> },
  { id: "configure-a", label: "Materials", icon: <Palette className="h-4 w-4" /> },
  { id: "configure-b", label: "Build", icon: <FileText className="h-4 w-4" /> },
  { id: "pricing", label: "Pricing", icon: <DollarSign className="h-4 w-4" /> },
  { id: "stocking", label: "Stocking", icon: <Package className="h-4 w-4" /> },
] as const;
type StepId = (typeof STEPS)[number]["id"];

function emptyForm(defaults: DraftDefaults): ItemFormState {
  return {
    vendorId: defaults.vendorId,
    vendorName: defaults.vendorName,
    partNumber: "",
    productName: "",
    draftPoId: defaults.draftPoId,
    departmentId: defaults.departmentId,
    categoryId: defaults.categoryId,
    typeId: defaults.typeId,
    itemType: "OTHER",
    grade: "",
    fabric: "",
    finish: "",
    cushions: "",
    cleaningCode: "",
    tossPillows: "",
    hardware: "",
    hardwareFinish: "",
    options: "",
    description: "",
    descriptionMode: "auto",
    cost: "",
    msrp: "",
    retail: "",
    qty: "1",
    productWidth: "",
    productLength: "",
    productHeight: "",
    stockProgram: defaults.stockProgram,
    stockFamily: defaults.stockFamily,
    stockLocationId: defaults.stockLocationId,
    vignette: "",
    notes: "",
    status: "DRAFT",
    vendorStyleId: null,
    source: "MANUAL",
  };
}

// ─── Component ─────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (createdItem: { id: number; partNumber: string }) => void;
  vendors: Vendor[];
  departments: Department[];
  categories: Category[];
  types: Type[];
  stockLocations: StockLocation[];
  draftPos: DraftPo[];
  /** When set, the wizard pre-fills with this item's values (Edit / Duplicate). */
  prefill?: Partial<ItemFormState> | null;
  /** Edit mode: PATCH instead of POST. */
  editingItemId?: number | null;
}

export default function DraftItemWizard({
  open,
  onClose,
  onSaved,
  vendors,
  departments,
  categories,
  types,
  stockLocations,
  draftPos,
  prefill,
  editingItemId,
}: Readonly<Props>) {
  const { defaults, update: updateDefaults } = useStickyDraftDefaults();
  const [form, setForm] = useState<ItemFormState>(() => emptyForm(defaults));
  const [step, setStep] = useState<StepId>("vendor");
  const [saving, setSaving] = useState(false);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const stepBodyRef = useRef<HTMLDivElement | null>(null);

  // Reset form when modal opens. Apply sticky defaults; then any prefill
  // (edit/duplicate) overrides them.
  useEffect(() => {
    if (!open) return;
    const base = emptyForm(defaults);
    setForm(prefill ? { ...base, ...prefill } : base);
    setStep("vendor");
  }, [open, defaults, prefill]);

  // Keyboard-friendly nav: when the step changes (Next / Back / tab
  // click), auto-focus the first input/select/textarea inside the step
  // body so the buyer can keep typing without reaching for the mouse.
  // Per buyer feedback 2026-05-09: *"Might we also be able to tab to the
  // button and press space or enter to hit next? Trying to see if we can
  // not have to use the mouse so much."*
  useEffect(() => {
    if (!open) return;
    // Defer one tick so the new step's DOM has rendered before we focus.
    const id = globalThis.setTimeout(() => {
      const root = stepBodyRef.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(
        "input:not([type='hidden']), select, textarea, button[data-wizard-focus]",
      );
      first?.focus();
    }, 0);
    return () => globalThis.clearTimeout(id);
  }, [step, open]);

  const setField = <K extends keyof ItemFormState>(key: K, value: ItemFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Cascading filters.
  const filteredCategories = useMemo(
    () => (form.departmentId ? categories.filter((c) => c.departmentId === form.departmentId) : []),
    [categories, form.departmentId],
  );
  const filteredTypes = useMemo(
    () => (form.categoryId ? types.filter((t) => t.categoryId === form.categoryId) : []),
    [types, form.categoryId],
  );

  // Margin display (live).
  const margin = useMemo(() => {
    const cost = Number(form.cost);
    const retail = Number(form.retail);
    if (!Number.isFinite(cost) || !Number.isFinite(retail) || retail <= 0) return null;
    return ((retail - cost) / retail) * 100;
  }, [form.cost, form.retail]);

  // Step navigation.
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const isLastStep = stepIndex === STEPS.length - 1;
  const goNext = () => {
    if (!isLastStep) setStep(STEPS[stepIndex + 1].id);
  };
  const goBack = () => {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  };

  // Validation: minimum required fields to save.
  // Department + Category required (slice 4a — buyer asked to enforce the
  // dept→cat hierarchy). Type stays optional because not every product has one.
  const canSave =
    form.vendorName.trim().length > 0 &&
    form.partNumber.trim().length > 0 &&
    form.productName.trim().length > 0 &&
    form.cost !== "" &&
    form.retail !== "" &&
    form.departmentId !== null &&
    form.categoryId !== null;

  // Live description preview — uses the EXPORT-format (newline-joined)
  // so the buyer sees exactly what the POS will display in the product
  // card. The DB-stored value is comma-joined (matching the existing
  // PriceConfigurator convention) — see buildPayload.
  const assembledDescription = useMemo(
    () =>
      assembleDescriptionForExport({
        itemType: form.itemType,
        fabric: form.fabric,
        grade: form.grade,
        finish: form.finish,
        cleaningCode: form.cleaningCode,
        options: form.options,
        cushions: form.cushions,
        tossPillows: form.tossPillows,
        hardware: form.hardware,
        hardwareFinish: form.hardwareFinish,
        productWidth: form.productWidth,
        productLength: form.productLength,
        productHeight: form.productHeight,
      }),
    [
      form.itemType,
      form.fabric,
      form.grade,
      form.finish,
      form.cleaningCode,
      form.options,
      form.cushions,
      form.tossPillows,
      form.hardware,
      form.hardwareFinish,
      form.productWidth,
      form.productLength,
      form.productHeight,
    ],
  );

  const buildPayload = useCallback(() => {
    const description =
      form.descriptionMode === "manual"
        ? form.description.trim() || null
        : assembleDescription({
            itemType: form.itemType,
            fabric: form.fabric,
            grade: form.grade,
            finish: form.finish,
            cleaningCode: form.cleaningCode,
            options: form.options,
            cushions: form.cushions,
            tossPillows: form.tossPillows,
            hardware: form.hardware,
            hardwareFinish: form.hardwareFinish,
            productWidth: form.productWidth,
            productLength: form.productLength,
            productHeight: form.productHeight,
          }) || null;

    return {
      vendorId: form.vendorId,
      vendorName: form.vendorName.trim(),
      partNumber: form.partNumber.trim(),
      productName: form.productName.trim(),
      cost: Number(form.cost),
      retail: Number(form.retail),
      msrp: form.msrp === "" ? null : Number(form.msrp),
      description,
      departmentId: form.departmentId,
      categoryId: form.categoryId,
      typeId: form.typeId,
      itemType: form.itemType,
      grade: form.grade.trim() || null,
      fabric: form.fabric.trim() || null,
      finish: form.finish.trim() || null,
      cushions: form.cushions.trim() || null,
      cleaningCode: form.cleaningCode.trim() || null,
      tossPillows: form.tossPillows.trim() || null,
      hardware: form.hardware.trim() || null,
      hardwareFinish: form.hardwareFinish.trim() || null,
      options: form.options.trim() || null,
      productWidth: form.productWidth === "" ? null : Number(form.productWidth),
      productLength: form.productLength === "" ? null : Number(form.productLength),
      productHeight: form.productHeight === "" ? null : Number(form.productHeight),
      stockProgram: form.stockProgram,
      stockFamily: form.stockFamily.trim() || null,
      vignette: form.vignette.trim() || null,
      qty: Number(form.qty || 1),
      stockLocationId: form.stockLocationId,
      draftPoId: form.draftPoId,
      notes: form.notes.trim() || null,
      status: form.status,
      vendorStyleId: form.vendorStyleId,
      source: form.source,
    };
  }, [form]);

  const persistStickyFromForm = useCallback(() => {
    updateDefaults({
      vendorId: form.vendorId,
      vendorName: form.vendorName.trim(),
      departmentId: form.departmentId,
      categoryId: form.categoryId,
      typeId: form.typeId,
      stockLocationId: form.stockLocationId,
      stockProgram: form.stockProgram,
      stockFamily: form.stockFamily.trim(),
      draftPoId: form.draftPoId,
    });
  }, [form, updateDefaults]);

  const handleSave = async (closeAfter: boolean) => {
    if (!canSave) {
      toast.error("Vendor, Part Number, Product Name, Cost, and Retail are required.");
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      let saved: { id: number; partNumber: string };
      if (editingItemId) {
        const res = await axios.patch<{ item: { id: number; partNumber: string } }>(
          `/api/admin/buyer-drafts/items/${editingItemId}`,
          payload,
        );
        saved = res.data.item;
      } else {
        const res = await axios.post<{ item: { id: number; partNumber: string } }>(
          "/api/admin/buyer-drafts/items",
          payload,
        );
        saved = res.data.item;
      }
      persistStickyFromForm();
      onSaved(saved);
      toast.success(`Saved ${saved.partNumber}`);

      if (closeAfter) {
        onClose();
      } else {
        // "Save and add another" — reset per-item fields, keep sticky.
        const reset = emptyForm({
          ...defaults,
          vendorId: form.vendorId,
          vendorName: form.vendorName,
          departmentId: form.departmentId,
          categoryId: form.categoryId,
          typeId: form.typeId,
          stockLocationId: form.stockLocationId,
          stockProgram: form.stockProgram,
          stockFamily: form.stockFamily,
          draftPoId: form.draftPoId,
        });
        setForm(reset);
        setStep("identity"); // jump past vendor — they're keeping that
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="w-full max-w-3xl bg-white rounded-2xl shadow-xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-sh-stripe">
              <div>
                <DialogTitle as="h2" className="font-serif text-xl text-sh-navy">
                  {editingItemId ? "Edit draft item" : "New draft item"}
                </DialogTitle>
                <p className="text-xs text-sh-gray mt-1">
                  {form.vendorName ? `Building for ${form.vendorName}` : "Pick a vendor to begin"}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close wizard"
                className="text-sh-gray hover:text-sh-navy"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Step tabs */}
            <div role="tablist" className="flex border-b border-sh-stripe overflow-x-auto">
              {STEPS.map((s, idx) => {
                const isActive = s.id === step;
                const isDone = idx < stepIndex;
                return (
                  <button
                    key={s.id}
                    role="tab"
                    type="button"
                    aria-selected={isActive}
                    onClick={() => setStep(s.id)}
                    className={`flex-1 min-w-[100px] px-3 py-3 flex flex-col items-center gap-1 text-xs font-semibold transition-colors ${
                      isActive
                        ? "text-sh-blue border-b-2 border-sh-blue"
                        : "text-sh-gray border-b-2 border-transparent hover:bg-sh-stripe/40"
                    }`}
                  >
                    <span className="flex items-center gap-1">
                      {isDone ? (
                        <Check className="h-4 w-4 text-sh-gold" />
                      ) : (
                        <span className={isActive ? "text-sh-blue" : "text-sh-gray"}>{s.icon}</span>
                      )}
                      {s.label}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Body */}
            <div ref={stepBodyRef} className="flex-1 overflow-y-auto px-6 py-5">
              {step === "vendor" && (
                <VendorStep form={form} setField={setField} vendors={vendors} draftPos={draftPos} />
              )}
              {step === "identity" && (
                <IdentityStep
                  form={form}
                  setField={setField}
                  onOpenCatalogPicker={() => setCatalogPickerOpen(true)}
                />
              )}
              {step === "taxonomy" && (
                <TaxonomyStep
                  form={form}
                  setField={setField}
                  departments={departments}
                  categories={filteredCategories}
                  types={filteredTypes}
                />
              )}
              {step === "configure-a" && <MaterialsStep form={form} setField={setField} />}
              {step === "configure-b" && (
                <BuildStep
                  form={form}
                  setField={setField}
                  assembledDescription={assembledDescription}
                />
              )}
              {step === "pricing" && (
                <PricingStep form={form} setField={setField} margin={margin} />
              )}
              {step === "stocking" && (
                <StockingStep
                  form={form}
                  setField={setField}
                  stockLocations={stockLocations}
                  canSave={canSave}
                />
              )}
            </div>

            {/* Footer: Back / Next / Save */}
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-sh-stripe">
              <Button
                variant="secondary"
                onClick={goBack}
                disabled={stepIndex === 0 || saving}
                className="min-h-[44px]"
              >
                <ChevronLeft className="h-4 w-4 mr-1" /> Back
              </Button>

              <div className="flex gap-2">
                {isLastStep ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => void handleSave(false)}
                      disabled={!canSave || saving}
                      className="min-h-[44px]"
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <PlusCircle className="h-4 w-4 mr-1" />
                      )}
                      Save & add another
                    </Button>
                    <Button
                      onClick={() => void handleSave(true)}
                      disabled={!canSave || saving}
                      className="min-h-[44px]"
                    >
                      {saving ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 mr-1" />
                      )}
                      {editingItemId ? "Save changes" : "Save"}
                    </Button>
                  </>
                ) : (
                  <Button onClick={goNext} disabled={saving} className="min-h-[44px]">
                    Next <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                )}
              </div>
            </div>
          </DialogPanel>
        </div>
      </div>

      {/* Catalog picker — opened from the Identity step */}
      <VendorStylePickerModal
        open={catalogPickerOpen}
        vendorId={form.vendorId}
        vendorName={form.vendorName}
        onClose={() => setCatalogPickerOpen(false)}
        onPick={(picked) => {
          // Apply picked fields. Don't touch fields the buyer may have
          // already filled (vendorName, qty, draftPo, stockProgram, etc.).
          setField("vendorStyleId", picked.vendorStyleId);
          setField("partNumber", picked.partNumber);
          setField("productName", picked.productName);
          if (picked.cost) setField("cost", picked.cost);
          if (picked.retail) setField("retail", picked.retail);
          if (picked.productWidth) setField("productWidth", picked.productWidth);
          if (picked.productLength) setField("productLength", picked.productLength);
          if (picked.productHeight) setField("productHeight", picked.productHeight);
          // Only override taxonomy if the buyer hasn't already set it.
          if (form.departmentId === null && picked.departmentId !== null)
            setField("departmentId", picked.departmentId);
          if (form.categoryId === null && picked.categoryId !== null)
            setField("categoryId", picked.categoryId);
          if (form.typeId === null && picked.typeId !== null) setField("typeId", picked.typeId);
          // Mark the source as CONFIGURATOR so the export can distinguish
          // catalog-sourced drafts from manual entries.
          setField("source", "CONFIGURATOR");
        }}
      />
    </Dialog>
  );
}

// ─── Step components ───────────────────────────────────────────────────

type SetField = <K extends keyof ItemFormState>(key: K, value: ItemFormState[K]) => void;

function VendorStep({
  form,
  setField,
  vendors,
  draftPos,
}: Readonly<{
  form: ItemFormState;
  setField: SetField;
  vendors: Vendor[];
  draftPos: DraftPo[];
}>) {
  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <label htmlFor="wizard-vendor" className="block text-sm font-semibold text-sh-navy mb-1">
          Supplier
        </label>
        <p className="text-xs text-sh-gray mb-2">
          Pick an existing vendor or type a new one below if you&apos;re drafting from a supplier we
          don&apos;t have a record for yet.
        </p>
        <select
          id="wizard-vendor"
          value={form.vendorId ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            const matched = vendors.find((x) => x.id === v);
            setField("vendorId", v);
            if (matched) setField("vendorName", matched.name);
          }}
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base bg-white"
        >
          <option value="">— New vendor (type below) —</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.code ? ` (${v.code})` : ""}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label
          htmlFor="wizard-vendor-name"
          className="block text-sm font-semibold text-sh-navy mb-1"
        >
          Supplier name (as it should appear on the export)
        </label>
        <input
          id="wizard-vendor-name"
          type="text"
          value={form.vendorName}
          onChange={(e) => setField("vendorName", e.target.value)}
          placeholder="e.g. Wesley Hall"
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
        />
      </div>

      <div>
        <label htmlFor="wizard-po" className="block text-sm font-semibold text-sh-navy mb-1">
          Add to draft PO (optional)
        </label>
        <p className="text-xs text-sh-gray mb-2">
          Group this item with others on a single the POS PO export. You can also leave it
          unassigned and group items later.
        </p>
        <select
          id="wizard-po"
          value={form.draftPoId ?? ""}
          onChange={(e) =>
            setField("draftPoId", e.target.value === "" ? null : Number(e.target.value))
          }
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base bg-white"
        >
          <option value="">— Unassigned —</option>
          {draftPos.map((po) => (
            <option key={po.id} value={po.id}>
              {po.referenceNumber ?? `PO #${po.id}`} — {po.vendor?.name ?? po.vendorName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function IdentityStep({
  form,
  setField,
  onOpenCatalogPicker,
}: Readonly<{
  form: ItemFormState;
  setField: SetField;
  onOpenCatalogPicker: () => void;
}>) {
  return (
    <div className="space-y-5 max-w-xl">
      {/* Pick-from-catalog affordance — only when a vendor is selected */}
      {form.vendorId !== null && (
        <div className="flex items-center justify-between gap-3 p-3 border border-sh-stripe rounded bg-sh-stripe/30">
          <div>
            <div className="text-sm font-semibold text-sh-navy">Pre-fill from catalog</div>
            <div className="text-xs text-sh-gray mt-0.5">
              Pick an existing vendor style and the wizard fills in part #, name, cost, retail, and
              dimensions for you.
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={onOpenCatalogPicker}
            className="min-h-[36px] whitespace-nowrap"
          >
            <Search className="h-4 w-4 mr-1" /> Pick from catalog
          </Button>
        </div>
      )}

      <div>
        <label htmlFor="wizard-part" className="block text-sm font-semibold text-sh-navy mb-1">
          Part number
        </label>
        <p className="text-xs text-sh-gray mb-2">
          The vendor&apos;s SKU / Item#. This is what the POS imports as the product number.
        </p>
        <input
          id="wizard-part"
          type="text"
          value={form.partNumber}
          onChange={(e) => setField("partNumber", e.target.value)}
          placeholder="e.g. L2272-05SW"
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base font-mono"
        />
      </div>
      <div>
        <label htmlFor="wizard-name" className="block text-sm font-semibold text-sh-navy mb-1">
          Product name
        </label>
        <input
          id="wizard-name"
          type="text"
          value={form.productName}
          onChange={(e) => setField("productName", e.target.value)}
          placeholder="e.g. Murphey Swivel Chair"
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
        />
      </div>
      <div>
        <label htmlFor="wizard-qty" className="block text-sm font-semibold text-sh-navy mb-1">
          Quantity
        </label>
        <input
          id="wizard-qty"
          type="number"
          min={1}
          value={form.qty}
          onChange={(e) => setField("qty", e.target.value)}
          className="w-32 px-3 py-2 border border-sh-stripe rounded text-base text-right"
        />
      </div>
    </div>
  );
}

function TaxonomyStep({
  form,
  setField,
  departments,
  categories,
  types,
}: Readonly<{
  form: ItemFormState;
  setField: SetField;
  departments: Department[];
  categories: Category[];
  types: Type[];
}>) {
  // Whether the selected category has any types defined. Drives whether
  // the Type dropdown is shown — categories with no types should hide
  // the field entirely so the buyer doesn't wonder why it's empty.
  const categoryHasTypes = form.categoryId !== null && types.length > 0;

  return (
    <div className="space-y-5 max-w-xl">
      <p className="text-xs text-sh-gray">
        Department and category drive the POS&apos;s reporting hierarchy. These stick across items
        in this session — your next item starts with the same dept/category pre-selected.{" "}
        <strong className="text-sh-navy">Department + Category are required to save.</strong>
      </p>
      <div>
        <label htmlFor="wizard-dept" className="block text-sm font-semibold text-sh-navy mb-1">
          Department <span className="text-red-600">*</span>
        </label>
        <select
          id="wizard-dept"
          value={form.departmentId ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            setField("departmentId", v);
            setField("categoryId", null);
            setField("typeId", null);
          }}
          className={`w-full px-3 py-2 border rounded text-base bg-white ${
            form.departmentId ? "border-sh-stripe" : "border-red-300"
          }`}
        >
          <option value="">— Pick a department —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="wizard-cat" className="block text-sm font-semibold text-sh-navy mb-1">
          Category <span className="text-red-600">*</span>
        </label>
        <select
          id="wizard-cat"
          value={form.categoryId ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            setField("categoryId", v);
            setField("typeId", null);
          }}
          disabled={!form.departmentId}
          className={`w-full px-3 py-2 border rounded text-base bg-white disabled:bg-sh-stripe/40 ${
            form.categoryId || !form.departmentId ? "border-sh-stripe" : "border-red-300"
          }`}
        >
          <option value="">
            {form.departmentId ? "— Pick a category —" : "— Select department first —"}
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Type — only render when the selected category actually has types
          defined. Saves the buyer from staring at an empty dropdown
          wondering whether something's broken. */}
      {categoryHasTypes && (
        <div>
          <label htmlFor="wizard-type" className="block text-sm font-semibold text-sh-navy mb-1">
            Type <span className="text-sh-gray font-normal">(optional)</span>
          </label>
          <select
            id="wizard-type"
            value={form.typeId ?? ""}
            onChange={(e) =>
              setField("typeId", e.target.value === "" ? null : Number(e.target.value))
            }
            className="w-full px-3 py-2 border border-sh-stripe rounded text-base bg-white"
          >
            <option value="">— None —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {form.categoryId !== null && !categoryHasTypes && (
        <p className="text-xs text-sh-gray italic">
          This category has no types defined — skip ahead.
        </p>
      )}
    </div>
  );
}

// MaterialsStep — Fabric / Leather / Grade / Finish / Cleaning Code.
// First half of the old Description step; the second half (Options +
// Dimensions + preview + free-text override + notes) lives in BuildStep.
function MaterialsStep({ form, setField }: Readonly<{ form: ItemFormState; setField: SetField }>) {
  return (
    <div className="space-y-5 max-w-2xl">
      <ItemTypeSelector form={form} setField={setField} />

      {form.itemType === "UPHOLSTERY" && (
        <UpholsteryMaterialsFields form={form} setField={setField} />
      )}
      {form.itemType === "CASE_GOODS" && (
        <CaseGoodsMaterialsFields form={form} setField={setField} />
      )}
      {form.itemType === "OTHER" && <OtherMaterialsFields form={form} setField={setField} />}
    </div>
  );
}

// Item-type selector — shown at the top of Materials. Drives which fields
// are surfaced both here and on the Build step. Buyer can change at any
// time; previously-typed values stay in their respective columns (no
// data loss on switch).
function ItemTypeSelector({
  form,
  setField,
}: Readonly<{ form: ItemFormState; setField: SetField }>) {
  const choices: Array<{ value: ItemFormState["itemType"]; label: string; hint: string }> = [
    {
      value: "UPHOLSTERY",
      label: "Upholstery",
      hint: "Sofa / chair / ottoman — fabric, grade, cushions, cleaning code",
    },
    {
      value: "CASE_GOODS",
      label: "Case Goods",
      hint: "Table / dresser / bed / cabinet — wood species, hardware",
    },
    {
      value: "OTHER",
      label: "Other",
      hint: "Accessories, rugs, lighting — generic free-form",
    },
  ];
  return (
    <fieldset>
      <legend className="block text-sm font-semibold text-sh-navy mb-2">
        Item type <span className="text-red-600">*</span>
      </legend>
      <p className="text-xs text-sh-gray mb-3">
        Sets the description template (which fields appear and how the description is laid out for
        the POS&apos;s product card).
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setField("itemType", c.value)}
            className={`text-left p-3 border rounded ${
              form.itemType === c.value
                ? "border-sh-blue bg-sh-blue/5"
                : "border-sh-stripe hover:bg-sh-stripe/30"
            }`}
          >
            <div className="text-sm font-semibold text-sh-navy">{c.label}</div>
            <div className="text-xs text-sh-gray mt-0.5">{c.hint}</div>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function UpholsteryMaterialsFields({
  form,
  setField,
}: Readonly<{ form: ItemFormState; setField: SetField }>) {
  return (
    <>
      <TextInput
        id="wizard-fabric"
        label="Fabric / Leather"
        value={form.fabric}
        onChange={(v) => setField("fabric", v)}
        placeholder="e.g. Stetson Chestnut, Calvin Sky"
      />
      <TextInput
        id="wizard-grade"
        label="Grade"
        value={form.grade}
        onChange={(v) => setField("grade", v)}
        placeholder="e.g. 13, C"
        helperText="Fabric grade number or leather letter — whatever the vendor uses."
      />
      <TextInput
        id="wizard-finish"
        label="Finish"
        value={form.finish}
        onChange={(v) => setField("finish", v)}
        placeholder="e.g. Mahogany, Renaissance"
      />
      <TextInput
        id="wizard-cushions"
        label="Cushions"
        value={form.cushions}
        onChange={(v) => setField("cushions", v)}
        placeholder="e.g. Mayfair down-blend, Spring Down BDB"
      />
      <CleaningCodeField form={form} setField={setField} />
    </>
  );
}

function CaseGoodsMaterialsFields({
  form,
  setField,
}: Readonly<{ form: ItemFormState; setField: SetField }>) {
  return (
    <>
      <TextInput
        id="wizard-grade"
        label="Wood species"
        value={form.grade}
        onChange={(v) => setField("grade", v)}
        placeholder="e.g. Walnut, White Oak, Cherry"
        helperText="The species column carries this value through to the description."
      />
      <TextInput
        id="wizard-finish"
        label="Finish"
        value={form.finish}
        onChange={(v) => setField("finish", v)}
        placeholder="e.g. Espresso, Natural Oil"
      />
      <TextInput
        id="wizard-hardware"
        label="Hardware"
        value={form.hardware}
        onChange={(v) => setField("hardware", v)}
        placeholder="e.g. Round knob, Bin pull"
      />
      <TextInput
        id="wizard-hardware-finish"
        label="Hardware finish"
        value={form.hardwareFinish}
        onChange={(v) => setField("hardwareFinish", v)}
        placeholder="e.g. Antique Brass, Polished Nickel"
      />
    </>
  );
}

function OtherMaterialsFields({
  form,
  setField,
}: Readonly<{ form: ItemFormState; setField: SetField }>) {
  return (
    <>
      <p className="text-xs text-sh-gray italic">
        Generic template — fill in whatever applies. Most accessory / rug / lighting items only need
        Finish + Options + Dimensions.
      </p>
      <TextInput
        id="wizard-fabric"
        label="Material / Fabric"
        value={form.fabric}
        onChange={(v) => setField("fabric", v)}
      />
      <TextInput
        id="wizard-grade"
        label="Grade / Tier"
        value={form.grade}
        onChange={(v) => setField("grade", v)}
      />
      <TextInput
        id="wizard-finish"
        label="Finish / Color"
        value={form.finish}
        onChange={(v) => setField("finish", v)}
      />
      <CleaningCodeField form={form} setField={setField} />
    </>
  );
}

// Reusable text input row for the wizard's Materials step.
function TextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  helperText,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  helperText?: string;
}>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-sh-navy mb-1">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
      />
      {helperText && <p className="text-xs text-sh-gray mt-1">{helperText}</p>}
    </div>
  );
}

function CleaningCodeField({
  form,
  setField,
}: Readonly<{ form: ItemFormState; setField: SetField }>) {
  return (
    <div>
      <label
        htmlFor="wizard-cleaning-code"
        className="block text-sm font-semibold text-sh-navy mb-1"
      >
        Cleaning code
      </label>
      <p className="text-xs text-sh-gray mb-2">
        Industry-standard upholstery cleaning code. Pick from common codes or type a vendor-specific
        one.
      </p>
      <div className="flex gap-2 flex-wrap">
        <input
          id="wizard-cleaning-code"
          type="text"
          value={form.cleaningCode}
          onChange={(e) => setField("cleaningCode", e.target.value)}
          placeholder="e.g. S, W, SW"
          className="w-32 px-3 py-2 border border-sh-stripe rounded text-base font-mono uppercase"
        />
        <div className="flex gap-1 flex-wrap">
          {CLEANING_CODE_PRESETS.map((preset) => (
            <button
              key={preset.code}
              type="button"
              onClick={() => setField("cleaningCode", preset.code)}
              className={`px-2 py-1.5 border rounded text-xs font-mono ${
                form.cleaningCode === preset.code
                  ? "border-sh-blue bg-sh-blue/10 text-sh-blue"
                  : "border-sh-stripe text-sh-gray hover:bg-sh-stripe/40"
              }`}
              title={preset.label}
            >
              {preset.code}
            </button>
          ))}
        </div>
      </div>
      {form.cleaningCode && (
        <p className="text-xs text-sh-gray mt-1.5">
          {CLEANING_CODE_PRESETS.find((p) => p.code === form.cleaningCode)?.label ??
            `Custom: ${form.cleaningCode}`}
        </p>
      )}
    </div>
  );
}

// BuildStep — Dimensions + Options + live multi-line description preview
// (in carriage-return / export format) + free-text override + internal
// notes. The buyer asked the dimensions to be part of the description
// step (2026-05-09); this combines both into one screen so the preview
// reflects everything that affects the description on save.
function BuildStep({
  form,
  setField,
  assembledDescription,
}: Readonly<{
  form: ItemFormState;
  setField: SetField;
  assembledDescription: string;
}>) {
  const isManual = form.descriptionMode === "manual";

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Mode toggle */}
      <div className="flex items-center justify-between border border-sh-stripe rounded p-3 bg-sh-stripe/30">
        <div>
          <div className="text-sm font-semibold text-sh-navy">Description source</div>
          <div className="text-xs text-sh-gray mt-0.5">
            {isManual
              ? "Free-text — type whatever you want."
              : "Auto-built from Materials + Options + Dimensions, with line breaks for the POS."}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setField("descriptionMode", isManual ? "auto" : "manual")}
          className="px-3 py-1.5 border border-sh-stripe rounded text-sm bg-white hover:bg-sh-stripe/60"
        >
          {isManual ? "Use structured fields" : "Free-text override"}
        </button>
      </div>

      {!isManual && (
        <>
          {/* Dimensions */}
          <fieldset>
            <legend className="block text-sm font-semibold text-sh-navy mb-2">
              Dimensions <span className="text-sh-gray font-normal">(inches, optional)</span>
            </legend>
            <p className="text-xs text-sh-gray mb-2">
              Appear in the Description as &ldquo;Dimensions: 30W x 39.5D x 34H&rdquo;.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="wizard-w" className="block text-xs font-semibold text-sh-navy mb-1">
                  Width
                </label>
                <input
                  id="wizard-w"
                  type="number"
                  step="0.25"
                  min={0}
                  value={form.productWidth}
                  onChange={(e) => setField("productWidth", e.target.value)}
                  placeholder="W"
                  className="w-full px-3 py-2 border border-sh-stripe rounded text-base text-right"
                />
              </div>
              <div>
                <label htmlFor="wizard-l" className="block text-xs font-semibold text-sh-navy mb-1">
                  Depth
                </label>
                <input
                  id="wizard-l"
                  type="number"
                  step="0.25"
                  min={0}
                  value={form.productLength}
                  onChange={(e) => setField("productLength", e.target.value)}
                  placeholder="D"
                  className="w-full px-3 py-2 border border-sh-stripe rounded text-base text-right"
                />
              </div>
              <div>
                <label htmlFor="wizard-h" className="block text-xs font-semibold text-sh-navy mb-1">
                  Height
                </label>
                <input
                  id="wizard-h"
                  type="number"
                  step="0.25"
                  min={0}
                  value={form.productHeight}
                  onChange={(e) => setField("productHeight", e.target.value)}
                  placeholder="H"
                  className="w-full px-3 py-2 border border-sh-stripe rounded text-base text-right"
                />
              </div>
            </div>
          </fieldset>

          {/* Toss Pillows — upholstery only */}
          {form.itemType === "UPHOLSTERY" && (
            <div>
              <label
                htmlFor="wizard-toss-pillows"
                className="block text-sm font-semibold text-sh-navy mb-1"
              >
                Toss pillows
              </label>
              <p className="text-xs text-sh-gray mb-2">
                Pillow count, sizes, fabric / trim. Example: &ldquo;(2) 22&quot; knife edge in
                Calvin Sky&rdquo;.
              </p>
              <textarea
                id="wizard-toss-pillows"
                value={form.tossPillows}
                onChange={(e) => setField("tossPillows", e.target.value)}
                placeholder='e.g. (2) 22" knife edge in Calvin Sky'
                rows={2}
                className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
              />
            </div>
          )}

          {/* Options */}
          <div>
            <label
              htmlFor="wizard-options"
              className="block text-sm font-semibold text-sh-navy mb-1"
            >
              Options
            </label>
            <p className="text-xs text-sh-gray mb-2">
              Trim, build-your-own selections, custom upgrades. Example: &ldquo;Tufted Back, French
              Nailhead, Brass Casters&rdquo;.
            </p>
            <textarea
              id="wizard-options"
              value={form.options}
              onChange={(e) => setField("options", e.target.value)}
              placeholder="e.g. Tufted Back, French Nailhead"
              rows={2}
              className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
            />
          </div>

          {/* Live preview — newline-joined to show exactly what the POS renders */}
          <div className="border border-sh-stripe rounded p-3 bg-sh-linen">
            <div className="text-xs font-semibold text-sh-navy uppercase tracking-wide mb-2">
              Description preview (as the POS will display)
            </div>
            <div className="text-sm text-sh-navy font-mono whitespace-pre-wrap min-h-[1.5em] bg-white border border-sh-stripe rounded p-2">
              {assembledDescription || (
                <span className="text-sh-gray italic">
                  Empty — fill in Materials, Options, or Dimensions to see a preview.
                </span>
              )}
            </div>
            <p className="text-xs text-sh-gray mt-2">
              Each line above appears as a separate line on the POS product card.
            </p>
          </div>
        </>
      )}

      {isManual && (
        <div>
          <label htmlFor="wizard-desc" className="block text-sm font-semibold text-sh-navy mb-1">
            Description (free text)
          </label>
          <textarea
            id="wizard-desc"
            value={form.description}
            onChange={(e) => setField("description", e.target.value)}
            placeholder={
              "Leather: Stetson Chestnut\nGrade: 13\nCushion: Mayfair\nDimensions: 30W x 39.5D x 34H"
            }
            rows={8}
            className="w-full px-3 py-2 border border-sh-stripe rounded text-base font-mono"
          />
          <p className="text-xs text-sh-gray mt-1">
            Press Enter for new lines. Each line appears separately on the POS product card.
          </p>
        </div>
      )}

      <div>
        <label htmlFor="wizard-notes" className="block text-sm font-semibold text-sh-navy mb-1">
          Internal notes (optional)
        </label>
        <p className="text-xs text-sh-gray mb-2">
          Anything for your team. Internal only — not exported.
        </p>
        <textarea
          id="wizard-notes"
          value={form.notes}
          onChange={(e) => setField("notes", e.target.value)}
          rows={2}
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
        />
      </div>
    </div>
  );
}

function PricingStep({
  form,
  setField,
  margin,
}: Readonly<{ form: ItemFormState; setField: SetField; margin: number | null }>) {
  return (
    <div className="space-y-5 max-w-xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="wizard-cost" className="block text-sm font-semibold text-sh-navy mb-1">
            Wholesale cost
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sh-gray">$</span>
            <input
              id="wizard-cost"
              type="number"
              step="0.01"
              min={0}
              value={form.cost}
              onChange={(e) => setField("cost", e.target.value)}
              className="w-full pl-7 pr-3 py-2 border border-sh-stripe rounded text-base text-right"
            />
          </div>
        </div>
        <div>
          <label htmlFor="wizard-msrp" className="block text-sm font-semibold text-sh-navy mb-1">
            MSRP / RRP
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sh-gray">$</span>
            <input
              id="wizard-msrp"
              type="number"
              step="0.01"
              min={0}
              value={form.msrp}
              onChange={(e) => setField("msrp", e.target.value)}
              className="w-full pl-7 pr-3 py-2 border border-sh-stripe rounded text-base text-right"
            />
          </div>
        </div>
        <div>
          <label htmlFor="wizard-retail" className="block text-sm font-semibold text-sh-navy mb-1">
            Selling price (retail)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sh-gray">$</span>
            <input
              id="wizard-retail"
              type="number"
              step="0.01"
              min={0}
              value={form.retail}
              onChange={(e) => setField("retail", e.target.value)}
              className="w-full pl-7 pr-3 py-2 border border-sh-stripe rounded text-base text-right"
            />
          </div>
        </div>
      </div>
      {margin !== null && (
        <div className="text-sm text-sh-gray bg-sh-stripe/50 rounded p-3">
          <span className="font-semibold text-sh-navy">{margin.toFixed(1)}% margin</span> at this
          cost / retail.
        </div>
      )}
    </div>
  );
}

// (DimensionsStep removed 2026-05-09 — folded into BuildStep so the
// description preview reflects dim values immediately.)

function StockingStep({
  form,
  setField,
  stockLocations,
  canSave,
}: Readonly<{
  form: ItemFormState;
  setField: SetField;
  stockLocations: StockLocation[];
  canSave: boolean;
}>) {
  return (
    <div className="space-y-6 max-w-xl">
      <fieldset>
        <legend className="block text-sm font-semibold text-sh-navy mb-2">Stocking program</legend>
        <label
          htmlFor="wizard-stock-program"
          className="flex items-start gap-3 p-3 border border-sh-stripe rounded cursor-pointer hover:bg-sh-stripe/30"
        >
          <input
            id="wizard-stock-program"
            type="checkbox"
            aria-label="Part of the stocking program"
            checked={form.stockProgram}
            onChange={(e) => setField("stockProgram", e.target.checked)}
            className="h-5 w-5 mt-0.5"
          />
          <span className="text-sm">
            <span className="font-semibold text-sh-navy">Part of the stocking program</span>
            <span className="block text-xs text-sh-gray mt-1">
              Tag this item as part of a vendor stocking program (e.g. Wesley Hall stocking sofas we
              keep on the floor). Drives the &ldquo;Stock Family&rdquo; column on the items export.
            </span>
          </span>
        </label>
      </fieldset>

      {form.stockProgram && (
        <div>
          <label
            htmlFor="wizard-stock-family"
            className="block text-sm font-semibold text-sh-navy mb-1"
          >
            Stock family
          </label>
          <p className="text-xs text-sh-gray mb-2">
            Free-text label that groups stocking items together. Examples: &ldquo;WH Bevel
            Arm&rdquo;, &ldquo;CRL Magnolia&rdquo;.
          </p>
          <input
            id="wizard-stock-family"
            type="text"
            value={form.stockFamily}
            onChange={(e) => setField("stockFamily", e.target.value)}
            placeholder="e.g. WH Bevel Arm Stocking"
            className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
          />
        </div>
      )}

      <div>
        <label htmlFor="wizard-loc" className="block text-sm font-semibold text-sh-navy mb-1">
          Where it lands
        </label>
        <p className="text-xs text-sh-gray mb-2">
          Stock location for the PO export. Sticks across items in this session.
        </p>
        <select
          id="wizard-loc"
          value={form.stockLocationId ?? ""}
          onChange={(e) =>
            setField("stockLocationId", e.target.value === "" ? null : Number(e.target.value))
          }
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base bg-white"
        >
          <option value="">— None —</option>
          {stockLocations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.code} — {loc.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="wizard-vignette" className="block text-sm font-semibold text-sh-navy mb-1">
          Vignette / floor-plan area <span className="text-sh-gray font-normal">(optional)</span>
        </label>
        <p className="text-xs text-sh-gray mb-2">
          Display grouping inside the location — e.g. &ldquo;Vignette 1&rdquo;, &ldquo;Living Room
          Display&rdquo;, &ldquo;Front Window&rdquo;. Multiple items can share a vignette, and one
          stock location can host several vignettes. Drives the Floor Plan sheet on the buyer
          workbook export.
        </p>
        <input
          id="wizard-vignette"
          type="text"
          value={form.vignette}
          onChange={(e) => setField("vignette", e.target.value)}
          placeholder="e.g. Vignette 3, Front Window"
          className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
        />
      </div>

      <fieldset>
        <legend className="block text-sm font-semibold text-sh-navy mb-2">Status on save</legend>
        <div className="grid grid-cols-2 gap-3">
          <label
            htmlFor="wizard-status-draft"
            className={`p-3 border rounded cursor-pointer ${
              form.status === "DRAFT"
                ? "border-sh-blue bg-sh-blue/5"
                : "border-sh-stripe hover:bg-sh-stripe/30"
            }`}
          >
            <input
              id="wizard-status-draft"
              type="radio"
              name="status"
              value="DRAFT"
              checked={form.status === "DRAFT"}
              onChange={() => setField("status", "DRAFT")}
              className="sr-only"
            />
            <span className="text-sm font-semibold text-sh-navy">Save as DRAFT</span>
            <span className="block text-xs text-sh-gray mt-1">
              Still being figured out. Won&apos;t appear in the next export batch.
            </span>
          </label>
          <label
            htmlFor="wizard-status-ready"
            className={`p-3 border rounded cursor-pointer ${
              form.status === "READY"
                ? "border-sh-blue bg-sh-blue/5"
                : "border-sh-stripe hover:bg-sh-stripe/30"
            }`}
          >
            <input
              id="wizard-status-ready"
              type="radio"
              name="status"
              value="READY"
              checked={form.status === "READY"}
              onChange={() => setField("status", "READY")}
              className="sr-only"
            />
            <span className="text-sm font-semibold text-sh-navy">Mark READY</span>
            <span className="block text-xs text-sh-gray mt-1">
              Locked in. Will be included on the next Items / POs CSV export.
            </span>
          </label>
        </div>
      </fieldset>

      {!canSave && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Required fields missing. Go back to fill in: Vendor, Part Number, Product Name, Cost, and
          Retail.
        </div>
      )}
    </div>
  );
}
