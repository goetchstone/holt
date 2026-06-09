// /app/src/components/form/TaxonomyPicker.tsx
//
// Cascading Vendor / Department / Category / Type dropdowns. Used by the
// Detailed Sales drilldown "Create New Product" flow and the bulk
// categorization admin page. Loads all four taxonomies once on mount and
// filters categories / types client-side as the user picks upstream values.
//
// When an upstream value changes (e.g. Department), the downstream values
// (Category, Type) are cleared — a "Rugs" department can't have a "Dining
// Chair" category, so stale selections would silently break the submit.

import { useEffect, useMemo, useState } from "react";
import axios from "axios";

interface Vendor {
  id: number;
  name: string;
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

export interface TaxonomyPickerProps {
  vendorId: number | null;
  departmentId: number | null;
  categoryId: number | null;
  typeId: number | null;
  onChange: (next: {
    vendorId: number | null;
    departmentId: number | null;
    categoryId: number | null;
    typeId: number | null;
  }) => void;
  requireVendor?: boolean;
  hideType?: boolean;
  disabled?: boolean;
}

export default function TaxonomyPicker({
  vendorId,
  departmentId,
  categoryId,
  typeId,
  onChange,
  requireVendor = true,
  hideType = false,
  disabled = false,
}: TaxonomyPickerProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [types, setTypes] = useState<Type[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      axios.get<{ vendors: Vendor[] }>("/api/vendors?all=true"),
      axios.get<{ departments: Department[] }>("/api/departments?all=true"),
      axios.get<{ categories: { id: number; name: string; departmentId: number }[] }>(
        "/api/categories?all=true",
      ),
      axios.get<{ types: { id: number; name: string; categoryId: number }[] }>(
        "/api/types?all=true",
      ),
    ])
      .then(([vRes, dRes, cRes, tRes]) => {
        setVendors(vRes.data.vendors ?? []);
        setDepartments(dRes.data.departments ?? []);
        setCategories(cRes.data.categories ?? []);
        setTypes(tRes.data.types ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredCategories = useMemo(
    () => (departmentId ? categories.filter((c) => c.departmentId === departmentId) : []),
    [categories, departmentId],
  );

  const filteredTypes = useMemo(
    () => (categoryId ? types.filter((t) => t.categoryId === categoryId) : []),
    [types, categoryId],
  );

  function setVendor(id: number | null) {
    onChange({ vendorId: id, departmentId, categoryId, typeId });
  }
  function setDepartment(id: number | null) {
    // Clear downstream
    onChange({ vendorId, departmentId: id, categoryId: null, typeId: null });
  }
  function setCategory(id: number | null) {
    onChange({ vendorId, departmentId, categoryId: id, typeId: null });
  }
  function setType(id: number | null) {
    onChange({ vendorId, departmentId, categoryId, typeId: id });
  }

  const selectCls =
    "w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black focus:outline-none focus:ring-1 focus:ring-sh-blue min-h-[40px] bg-white disabled:bg-sh-linen disabled:text-sh-gray";

  return (
    <div className={`grid ${hideType ? "grid-cols-3" : "grid-cols-2 md:grid-cols-4"} gap-3`}>
      <div>
        <label className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
          Vendor {requireVendor && <span className="text-red-500">*</span>}
        </label>
        <select
          value={vendorId ?? ""}
          onChange={(e) => setVendor(e.target.value ? Number.parseInt(e.target.value, 10) : null)}
          disabled={disabled || loading}
          className={selectCls}
        >
          <option value="">— Select —</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
          Department <span className="text-red-500">*</span>
        </label>
        <select
          value={departmentId ?? ""}
          onChange={(e) =>
            setDepartment(e.target.value ? Number.parseInt(e.target.value, 10) : null)
          }
          disabled={disabled || loading}
          className={selectCls}
        >
          <option value="">— Select —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
          Category <span className="text-red-500">*</span>
        </label>
        <select
          value={categoryId ?? ""}
          onChange={(e) => setCategory(e.target.value ? Number.parseInt(e.target.value, 10) : null)}
          disabled={disabled || loading || !departmentId}
          className={selectCls}
        >
          <option value="">{departmentId ? "— Select —" : "Pick a department first"}</option>
          {filteredCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {!hideType && (
        <div>
          <label className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
            Type
          </label>
          <select
            value={typeId ?? ""}
            onChange={(e) => setType(e.target.value ? Number.parseInt(e.target.value, 10) : null)}
            disabled={disabled || loading || !categoryId}
            className={selectCls}
          >
            <option value="">
              {categoryId
                ? filteredTypes.length > 0
                  ? "— None —"
                  : "— No types available —"
                : "Pick a category first"}
            </option>
            {filteredTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
