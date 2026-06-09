"use client";

// /app/src/app/(dashboard)/app/admin/setup/product-pairings/ProductPairingsView.tsx
//
// Product Pairings body. App Router port of the legacy admin/setup/product-pairings
// body (minus MainLayout chrome, which the (dashboard) layout supplies). CRUD
// over the shared /api/admin/product-pairings REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { getErrorMessage } from "@/lib/toastError";

interface Department {
  id: number;
  name: string;
}

interface Category {
  id: number;
  name: string;
  departmentId: number;
}

interface Pairing {
  id: number;
  name: string;
  description: string | null;
  fromDepartmentId: number;
  fromDepartment: { id: number; name: string };
  fromCategoryId: number | null;
  fromCategory: { id: number; name: string } | null;
  toDepartmentId: number;
  toDepartment: { id: number; name: string };
  toCategoryId: number | null;
  toCategory: { id: number; name: string } | null;
  windowDays: number;
  isActive: boolean;
  sortOrder: number;
}

interface PairingForm {
  name: string;
  description: string;
  fromDepartmentId: string;
  fromCategoryId: string;
  toDepartmentId: string;
  toCategoryId: string;
  windowDays: string;
  isActive: boolean;
  sortOrder: string;
}

const emptyForm: PairingForm = {
  name: "",
  description: "",
  fromDepartmentId: "",
  fromCategoryId: "",
  toDepartmentId: "",
  toCategoryId: "",
  windowDays: "60",
  isActive: true,
  sortOrder: "0",
};

function describeEnd(dept: { name: string }, cat: { name: string } | null) {
  return cat ? `${dept.name} / ${cat.name}` : dept.name;
}

function PairingModal({
  pairing,
  departments,
  categories,
  onClose,
  onRefresh,
}: {
  pairing: Pairing | null;
  departments: Department[];
  categories: Category[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isEdit = pairing !== null;
  const [form, setForm] = useState<PairingForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (pairing) {
      setForm({
        name: pairing.name,
        description: pairing.description ?? "",
        fromDepartmentId: String(pairing.fromDepartmentId),
        fromCategoryId: pairing.fromCategoryId ? String(pairing.fromCategoryId) : "",
        toDepartmentId: String(pairing.toDepartmentId),
        toCategoryId: pairing.toCategoryId ? String(pairing.toCategoryId) : "",
        windowDays: String(pairing.windowDays),
        isActive: pairing.isActive,
        sortOrder: String(pairing.sortOrder),
      });
    } else {
      setForm(emptyForm);
    }
  }, [pairing]);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        fromDepartmentId: Number(form.fromDepartmentId),
        fromCategoryId: form.fromCategoryId ? Number(form.fromCategoryId) : null,
        toDepartmentId: Number(form.toDepartmentId),
        toCategoryId: form.toCategoryId ? Number(form.toCategoryId) : null,
        windowDays: Number(form.windowDays) || 60,
        isActive: form.isActive,
        sortOrder: Number(form.sortOrder) || 0,
      };
      const url = isEdit
        ? `/api/admin/product-pairings/${pairing.id}`
        : "/api/admin/product-pairings";
      const method = isEdit ? "put" : "post";
      await axios.request({ url, method, data: body });
      toast.success(isEdit ? "Pairing updated" : "Pairing created");
      onRefresh();
      onClose();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save pairing"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pairing) return;
    if (!confirm(`Delete pairing "${pairing.name}"? This cannot be undone.`)) return;
    setSaving(true);
    try {
      await axios.delete(`/api/admin/product-pairings/${pairing.id}`);
      toast.success("Pairing deleted");
      onRefresh();
      onClose();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to delete pairing"));
    } finally {
      setSaving(false);
    }
  };

  const deptOptions = departments.map((d) => ({ id: String(d.id), name: d.name }));
  const fromCatOptions = [
    { id: "", name: "(any category in this department)" },
    ...categories
      .filter((c) => c.departmentId === Number(form.fromDepartmentId))
      .map((c) => ({ id: String(c.id), name: c.name })),
  ];
  const toCatOptions = [
    { id: "", name: "(any category in this department)" },
    ...categories
      .filter((c) => c.departmentId === Number(form.toDepartmentId))
      .map((c) => ({ id: String(c.id), name: c.name })),
  ];

  return (
    <Modal
      title={isEdit ? "Edit Pairing" : "Add Pairing"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
      />
      <FormInput
        label="Description (optional)"
        name="description"
        value={form.description}
        onChange={(v) => setForm({ ...form, description: v })}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormDropdown
          label="From Department"
          options={deptOptions}
          value={form.fromDepartmentId}
          onChange={(v) => setForm({ ...form, fromDepartmentId: v, fromCategoryId: "" })}
        />
        <FormDropdown
          label="From Category"
          options={fromCatOptions}
          value={form.fromCategoryId}
          onChange={(v) => setForm({ ...form, fromCategoryId: v })}
          disabled={!form.fromDepartmentId}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormDropdown
          label="To Department"
          options={deptOptions}
          value={form.toDepartmentId}
          onChange={(v) => setForm({ ...form, toDepartmentId: v, toCategoryId: "" })}
        />
        <FormDropdown
          label="To Category"
          options={toCatOptions}
          value={form.toCategoryId}
          onChange={(v) => setForm({ ...form, toCategoryId: v })}
          disabled={!form.toDepartmentId}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormInput
          label="Window (days)"
          name="windowDays"
          value={form.windowDays}
          onChange={(v) => setForm({ ...form, windowDays: v })}
        />
        <FormInput
          label="Sort Order"
          name="sortOrder"
          value={form.sortOrder}
          onChange={(v) => setForm({ ...form, sortOrder: v })}
        />
      </div>
      <FormCheckbox
        label="Active"
        name="isActive"
        checked={form.isActive}
        onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
      />
      {isEdit && (
        <div className="pt-4 border-t border-sh-gray/10 mt-4">
          <Button variant="outline" onClick={handleDelete} disabled={saving}>
            Delete pairing
          </Button>
        </div>
      )}
    </Modal>
  );
}

function PairingActiveBadge({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">
        Active
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-sh-gray/10 text-sh-gray border border-sh-gray/20">
      Off
    </span>
  );
}

export function ProductPairingsView() {
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Pairing | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pairingsRes, deptsRes, catsRes] = await Promise.all([
        axios.get<{ pairings: Pairing[] }>("/api/admin/product-pairings"),
        axios.get<{ departments: Department[] }>("/api/departments?all=true"),
        axios.get<{ categories: Category[] }>("/api/categories"),
      ]);
      setPairings(pairingsRes.data.pairings);
      setDepartments(deptsRes.data.departments);
      setCategories(catsRes.data.categories);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load pairings"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (p: Pairing) => {
    setEditing(p);
    setModalOpen(true);
  };

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/admin" className="hover:underline">
          Admin
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Product Pairings</span>
      </nav>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-sh-navy">Product Pairings</h1>
          <p className="text-sm text-sh-gray mt-1">
            Define which product categories belong together. Customers who bought the
            &quot;from&quot; but never the &quot;to&quot; show up in the{" "}
            <Link href="/app/reports/opportunities" className="text-sh-blue hover:underline">
              Missing Pieces
            </Link>{" "}
            tile.
          </p>
        </div>
        <Button onClick={openAdd} className="flex items-center gap-2 min-h-[44px]">
          <Plus className="w-4 h-4" /> Add Pairing
        </Button>
      </div>

      {loading && <p className="text-sh-gray py-8">Loading...</p>}

      {!loading && pairings.length === 0 && (
        <div className="bg-white border border-sh-gray/15 rounded-xl p-8 text-center text-sm text-sh-gray">
          No pairings yet. Add one to start flagging cross-sell gaps.
        </div>
      )}

      {!loading && pairings.length > 0 && (
        <div className="bg-white border border-sh-gray/15 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/15 bg-sh-linen text-xs uppercase tracking-wide text-sh-gray">
                <th className="text-left px-4 py-2 font-semibold">Name</th>
                <th className="text-left px-4 py-2 font-semibold">From</th>
                <th className="text-left px-4 py-2 font-semibold">To</th>
                <th className="text-right px-4 py-2 font-semibold">Window</th>
                <th className="text-right px-4 py-2 font-semibold">Sort</th>
                <th className="text-center px-4 py-2 font-semibold">Active</th>
                <th className="text-right px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pairings.map((p, i) => (
                <tr
                  key={p.id}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-4 py-2">
                    <div className="text-sh-black font-medium">{p.name}</div>
                    {p.description && (
                      <div className="text-xs text-sh-gray mt-0.5">{p.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-sh-gray">
                    {describeEnd(p.fromDepartment, p.fromCategory)}
                  </td>
                  <td className="px-4 py-2 text-sh-gray">
                    {describeEnd(p.toDepartment, p.toCategory)}
                  </td>
                  <td className="px-4 py-2 text-right text-sh-gray">{p.windowDays}d</td>
                  <td className="px-4 py-2 text-right text-sh-gray">{p.sortOrder}</td>
                  <td className="px-4 py-2 text-center">
                    <PairingActiveBadge active={p.isActive} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <PairingModal
          pairing={editing}
          departments={departments}
          categories={categories}
          onClose={() => setModalOpen(false)}
          onRefresh={load}
        />
      )}
    </div>
  );
}
