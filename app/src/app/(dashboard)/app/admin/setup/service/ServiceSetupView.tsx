"use client";

// /app/src/app/(dashboard)/app/admin/setup/service/ServiceSetupView.tsx
//
// Service Settings body. App Router port of the legacy admin/setup/service body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Manages case
// types, statuses, and priorities via the shared /api/service/settings/* REST
// endpoints. The three sections share a SettingsCard table and per-entity edit
// modals.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";

interface CaseType {
  id: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

interface CaseStatus {
  id: number;
  name: string;
  isClosed: boolean;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
}

interface CasePriority {
  id: number;
  name: string;
  level: number;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
}

interface TypeForm {
  name: string;
  isActive: boolean;
  sortOrder: string;
}
interface StatusForm {
  name: string;
  isClosed: boolean;
  color: string;
  isActive: boolean;
  sortOrder: string;
}
interface PriorityForm {
  name: string;
  level: string;
  color: string;
  isActive: boolean;
  sortOrder: string;
}

function ColorCell({ color }: { color: string | null }) {
  if (!color) return <span className="text-sh-gray">--</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="inline-block w-4 h-4 rounded" style={{ backgroundColor: color }} />
      <span className="text-xs text-sh-gray">{color}</span>
    </span>
  );
}

interface Column<T> {
  header: string;
  render: (item: T) => React.ReactNode;
}

function SettingsCard<T extends { id: number }>({
  title,
  addLabel,
  columns,
  rows,
  emptyText,
  onAdd,
  onEdit,
}: {
  title: string;
  addLabel: string;
  columns: Column<T>[];
  rows: T[];
  emptyText: string;
  onAdd: () => void;
  onEdit: (item: T) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-sh-black">{title}</h2>
        <Button variant="primary" size="sm" onClick={onAdd}>
          {addLabel}
        </Button>
      </div>
      <table className="min-w-full text-left text-sm">
        <thead className="bg-sh-linen text-sh-black">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className="p-3 border-b font-medium">
                {c.header}
              </th>
            ))}
            <th className="p-3 border-b font-medium w-20"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="odd:bg-white even:bg-sh-stripe">
              {columns.map((c) => (
                <td key={c.header} className="p-3 border-b">
                  {c.render(row)}
                </td>
              ))}
              <td className="p-3 border-b">
                <button
                  onClick={() => onEdit(row)}
                  className="text-sm text-sh-blue hover:underline"
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className="p-3 text-center text-sh-gray">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ServiceSetupView() {
  const [types, setTypes] = useState<CaseType[]>([]);
  const [statuses, setStatuses] = useState<CaseStatus[]>([]);
  const [priorities, setPriorities] = useState<CasePriority[]>([]);
  const [loading, setLoading] = useState(true);

  // Type modal
  const [typeModal, setTypeModal] = useState<{ editing: CaseType | null } | null>(null);
  const [typeForm, setTypeForm] = useState<TypeForm>({ name: "", isActive: true, sortOrder: "0" });
  const [typeSaving, setTypeSaving] = useState(false);

  // Status modal
  const [statusModal, setStatusModal] = useState<{ editing: CaseStatus | null } | null>(null);
  const [statusForm, setStatusForm] = useState<StatusForm>({
    name: "",
    isClosed: false,
    color: "",
    isActive: true,
    sortOrder: "0",
  });
  const [statusSaving, setStatusSaving] = useState(false);

  // Priority modal
  const [priorityModal, setPriorityModal] = useState<{ editing: CasePriority | null } | null>(null);
  const [priorityForm, setPriorityForm] = useState<PriorityForm>({
    name: "",
    level: "0",
    color: "",
    isActive: true,
    sortOrder: "0",
  });
  const [prioritySaving, setPrioritySaving] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [typesRes, statusesRes, prioritiesRes] = await Promise.all([
        fetch("/api/service/settings/types"),
        fetch("/api/service/settings/statuses"),
        fetch("/api/service/settings/priorities"),
      ]);
      const typesData = typesRes.ok ? await typesRes.json() : {};
      const statusesData = statusesRes.ok ? await statusesRes.json() : {};
      const prioritiesData = prioritiesRes.ok ? await prioritiesRes.json() : {};
      setTypes(typesData.types || []);
      setStatuses(statusesData.statuses || []);
      setPriorities(prioritiesData.priorities || []);
    } catch {
      toast.error("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Type handlers
  const openTypeModal = (item: CaseType | null) => {
    setTypeForm(
      item
        ? { name: item.name, isActive: item.isActive, sortOrder: String(item.sortOrder) }
        : { name: "", isActive: true, sortOrder: "0" },
    );
    setTypeModal({ editing: item });
  };

  const saveType = async () => {
    if (!typeForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setTypeSaving(true);
    try {
      const payload = {
        name: typeForm.name.trim(),
        isActive: typeForm.isActive,
        sortOrder: Number.parseInt(typeForm.sortOrder) || 0,
      };
      if (typeModal?.editing) {
        const res = await fetch(`/api/service/settings/types/${typeModal.editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      } else {
        const res = await fetch("/api/service/settings/types", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      }
      setTypeModal(null);
      toast.success("Case type saved");
      fetchAll();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save"));
    } finally {
      setTypeSaving(false);
    }
  };

  // Status handlers
  const openStatusModal = (item: CaseStatus | null) => {
    setStatusForm(
      item
        ? {
            name: item.name,
            isClosed: item.isClosed,
            color: item.color || "",
            isActive: item.isActive,
            sortOrder: String(item.sortOrder),
          }
        : { name: "", isClosed: false, color: "", isActive: true, sortOrder: "0" },
    );
    setStatusModal({ editing: item });
  };

  const saveStatus = async () => {
    if (!statusForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setStatusSaving(true);
    try {
      const payload = {
        name: statusForm.name.trim(),
        isClosed: statusForm.isClosed,
        color: statusForm.color || null,
        isActive: statusForm.isActive,
        sortOrder: Number.parseInt(statusForm.sortOrder) || 0,
      };
      if (statusModal?.editing) {
        const res = await fetch(`/api/service/settings/statuses/${statusModal.editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      } else {
        const res = await fetch("/api/service/settings/statuses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      }
      setStatusModal(null);
      toast.success("Case status saved");
      fetchAll();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save"));
    } finally {
      setStatusSaving(false);
    }
  };

  // Priority handlers
  const openPriorityModal = (item: CasePriority | null) => {
    setPriorityForm(
      item
        ? {
            name: item.name,
            level: String(item.level),
            color: item.color || "",
            isActive: item.isActive,
            sortOrder: String(item.sortOrder),
          }
        : { name: "", level: "0", color: "", isActive: true, sortOrder: "0" },
    );
    setPriorityModal({ editing: item });
  };

  const savePriority = async () => {
    if (!priorityForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setPrioritySaving(true);
    try {
      const payload = {
        name: priorityForm.name.trim(),
        level: Number.parseInt(priorityForm.level) || 0,
        color: priorityForm.color || null,
        isActive: priorityForm.isActive,
        sortOrder: Number.parseInt(priorityForm.sortOrder) || 0,
      };
      if (priorityModal?.editing) {
        const res = await fetch(`/api/service/settings/priorities/${priorityModal.editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      } else {
        const res = await fetch("/api/service/settings/priorities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error || "Failed to save");
      }
      setPriorityModal(null);
      toast.success("Priority saved");
      fetchAll();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save"));
    } finally {
      setPrioritySaving(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray py-8 font-serif">Loading...</p>;
  }

  return (
    <div className="py-2 space-y-8 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Service Settings</h1>

      <SettingsCard<CaseType>
        title="Case Types"
        addLabel="Add Type"
        rows={types}
        emptyText="No case types configured"
        onAdd={() => openTypeModal(null)}
        onEdit={openTypeModal}
        columns={[
          { header: "Name", render: (t) => t.name },
          { header: "Active", render: (t) => (t.isActive ? "Yes" : "No") },
          { header: "Sort Order", render: (t) => t.sortOrder },
        ]}
      />

      <SettingsCard<CaseStatus>
        title="Case Statuses"
        addLabel="Add Status"
        rows={statuses}
        emptyText="No statuses configured"
        onAdd={() => openStatusModal(null)}
        onEdit={openStatusModal}
        columns={[
          { header: "Name", render: (s) => s.name },
          { header: "Is Closed", render: (s) => (s.isClosed ? "Yes" : "No") },
          { header: "Color", render: (s) => <ColorCell color={s.color} /> },
          { header: "Active", render: (s) => (s.isActive ? "Yes" : "No") },
          { header: "Sort Order", render: (s) => s.sortOrder },
        ]}
      />

      <SettingsCard<CasePriority>
        title="Priorities"
        addLabel="Add Priority"
        rows={priorities}
        emptyText="No priorities configured"
        onAdd={() => openPriorityModal(null)}
        onEdit={openPriorityModal}
        columns={[
          { header: "Name", render: (p) => p.name },
          { header: "Level", render: (p) => p.level },
          { header: "Color", render: (p) => <ColorCell color={p.color} /> },
          { header: "Active", render: (p) => (p.isActive ? "Yes" : "No") },
          { header: "Sort Order", render: (p) => p.sortOrder },
        ]}
      />

      {/* Type Modal */}
      {typeModal && (
        <Modal
          title={typeModal.editing ? "Edit Case Type" : "Add Case Type"}
          onClose={() => setTypeModal(null)}
          onSave={saveType}
          saving={typeSaving}
        >
          <FormInput
            label="Name"
            name="typeName"
            value={typeForm.name}
            onChange={(v) => setTypeForm((f) => ({ ...f, name: v }))}
            required
          />
          <FormInput
            label="Sort Order"
            name="typeSortOrder"
            type="number"
            value={typeForm.sortOrder}
            onChange={(v) => setTypeForm((f) => ({ ...f, sortOrder: v }))}
          />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="typeActive"
              checked={typeForm.isActive}
              onChange={(e) => setTypeForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="typeActive" className="text-sm text-sh-gray">
              Active
            </label>
          </div>
        </Modal>
      )}

      {/* Status Modal */}
      {statusModal && (
        <Modal
          title={statusModal.editing ? "Edit Case Status" : "Add Case Status"}
          onClose={() => setStatusModal(null)}
          onSave={saveStatus}
          saving={statusSaving}
        >
          <FormInput
            label="Name"
            name="statusName"
            value={statusForm.name}
            onChange={(v) => setStatusForm((f) => ({ ...f, name: v }))}
            required
          />
          <FormInput
            label="Color (hex)"
            name="statusColor"
            value={statusForm.color}
            onChange={(v) => setStatusForm((f) => ({ ...f, color: v }))}
            placeholder="#3B82F6"
          />
          <FormInput
            label="Sort Order"
            name="statusSortOrder"
            type="number"
            value={statusForm.sortOrder}
            onChange={(v) => setStatusForm((f) => ({ ...f, sortOrder: v }))}
          />
          <div className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              id="statusClosed"
              checked={statusForm.isClosed}
              onChange={(e) => setStatusForm((f) => ({ ...f, isClosed: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="statusClosed" className="text-sm text-sh-gray">
              Is Closed Status
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="statusActive"
              checked={statusForm.isActive}
              onChange={(e) => setStatusForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="statusActive" className="text-sm text-sh-gray">
              Active
            </label>
          </div>
        </Modal>
      )}

      {/* Priority Modal */}
      {priorityModal && (
        <Modal
          title={priorityModal.editing ? "Edit Priority" : "Add Priority"}
          onClose={() => setPriorityModal(null)}
          onSave={savePriority}
          saving={prioritySaving}
        >
          <FormInput
            label="Name"
            name="priorityName"
            value={priorityForm.name}
            onChange={(v) => setPriorityForm((f) => ({ ...f, name: v }))}
            required
          />
          <FormInput
            label="Level"
            name="priorityLevel"
            type="number"
            value={priorityForm.level}
            onChange={(v) => setPriorityForm((f) => ({ ...f, level: v }))}
          />
          <FormInput
            label="Color (hex)"
            name="priorityColor"
            value={priorityForm.color}
            onChange={(v) => setPriorityForm((f) => ({ ...f, color: v }))}
            placeholder="#EF4444"
          />
          <FormInput
            label="Sort Order"
            name="prioritySortOrder"
            type="number"
            value={priorityForm.sortOrder}
            onChange={(v) => setPriorityForm((f) => ({ ...f, sortOrder: v }))}
          />
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="priorityActive"
              checked={priorityForm.isActive}
              onChange={(e) => setPriorityForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="priorityActive" className="text-sm text-sh-gray">
              Active
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
