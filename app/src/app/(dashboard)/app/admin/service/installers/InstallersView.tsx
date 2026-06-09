"use client";

// /app/src/app/(dashboard)/app/admin/service/installers/InstallersView.tsx
//
// Installers body. App Router port of the legacy admin/service/installers body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Manages the
// installer roster via the shared /api/service/installers REST endpoints. The
// add form and edit modal share the InstallerFields control set.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";

interface Installer {
  id: number;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
  staffMemberName: string | null;
}

interface InstallerForm {
  name: string;
  company: string;
  phone: string;
  email: string;
  notes: string;
  isActive: boolean;
}

const EMPTY_FORM: InstallerForm = {
  name: "",
  company: "",
  phone: "",
  email: "",
  notes: "",
  isActive: true,
};

function StatusBadge({ active }: { active: boolean }) {
  const cls = active ? "bg-green-100 text-green-800" : "bg-sh-gray/20 text-sh-gray";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{active ? "Active" : "Inactive"}</span>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-sh-gray mb-1">
        {label}
      </label>
      <input
        id={id}
        type={type}
        className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function InstallersView() {
  const [installers, setInstallers] = useState<Installer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<InstallerForm>({ ...EMPTY_FORM });
  const [addSaving, setAddSaving] = useState(false);

  const [editModal, setEditModal] = useState<{ installer: Installer } | null>(null);
  const [editForm, setEditForm] = useState<InstallerForm>({ ...EMPTY_FORM });
  const [editSaving, setEditSaving] = useState(false);

  const loadInstallers = useCallback(async () => {
    try {
      const res = await axios.get("/api/service/installers");
      setInstallers(res.data.installers || []);
    } catch {
      toast.error("Failed to load installers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInstallers();
  }, [loadInstallers]);

  const handleAdd = async () => {
    if (!addForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setAddSaving(true);
    try {
      await axios.post("/api/service/installers", {
        name: addForm.name.trim(),
        company: addForm.company.trim() || null,
        phone: addForm.phone.trim() || null,
        email: addForm.email.trim() || null,
        notes: addForm.notes.trim() || null,
      });
      toast.success("Installer added");
      setAddForm({ ...EMPTY_FORM });
      setShowAddForm(false);
      await loadInstallers();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to add installer"));
    } finally {
      setAddSaving(false);
    }
  };

  const openEdit = (installer: Installer) => {
    setEditForm({
      name: installer.name,
      company: installer.company || "",
      phone: installer.phone || "",
      email: installer.email || "",
      notes: installer.notes || "",
      isActive: installer.isActive,
    });
    setEditModal({ installer });
  };

  const handleEdit = async () => {
    if (!editModal || !editForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setEditSaving(true);
    try {
      await axios.put(`/api/service/installers/${editModal.installer.id}`, {
        name: editForm.name.trim(),
        company: editForm.company.trim() || null,
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        notes: editForm.notes.trim() || null,
        isActive: editForm.isActive,
      });
      toast.success("Installer updated");
      setEditModal(null);
      await loadInstallers();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update installer"));
    } finally {
      setEditSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray py-8">Loading...</p>;
  }

  return (
    <>
      <div className="py-2 space-y-6 font-serif">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl text-sh-blue font-semibold">Installer Management</h1>
          <Button
            variant="primary"
            onClick={() => {
              setShowAddForm(!showAddForm);
              setAddForm({ ...EMPTY_FORM });
            }}
          >
            {showAddForm ? "Cancel" : "Add Installer"}
          </Button>
        </div>

        {/* Add Form */}
        {showAddForm && (
          <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
            <h2 className="text-lg font-semibold text-sh-black mb-4">New Installer</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <TextField
                id="addName"
                label="Name *"
                value={addForm.name}
                onChange={(v) => setAddForm((f) => ({ ...f, name: v }))}
              />
              <TextField
                id="addCompany"
                label="Company (blank for in-house)"
                value={addForm.company}
                onChange={(v) => setAddForm((f) => ({ ...f, company: v }))}
              />
              <TextField
                id="addPhone"
                label="Phone"
                value={addForm.phone}
                onChange={(v) => setAddForm((f) => ({ ...f, phone: v }))}
              />
              <TextField
                id="addEmail"
                label="Email"
                value={addForm.email}
                onChange={(v) => setAddForm((f) => ({ ...f, email: v }))}
              />
            </div>
            <div className="mb-4">
              <label htmlFor="addNotes" className="block text-xs font-medium text-sh-gray mb-1">
                Notes
              </label>
              <textarea
                id="addNotes"
                className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                rows={2}
                value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="flex justify-end">
              <Button disabled={addSaving} onClick={handleAdd}>
                {addSaving ? "Saving..." : "Save Installer"}
              </Button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Name</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Company</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Phone</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Email</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Linked Staff</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[90px]">Status</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[80px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {installers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sh-gray">
                    No installers configured
                  </td>
                </tr>
              ) : (
                installers.map((inst) => (
                  <tr key={inst.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                    <td className="px-4 py-2 text-sh-black font-medium">{inst.name}</td>
                    <td className="px-4 py-2 text-sh-gray">{inst.company || "In-house"}</td>
                    <td className="px-4 py-2 text-sh-gray">{inst.phone || "--"}</td>
                    <td className="px-4 py-2 text-sh-gray">{inst.email || "--"}</td>
                    <td className="px-4 py-2 text-sh-gray">{inst.staffMemberName || "--"}</td>
                    <td className="px-4 py-2">
                      <StatusBadge active={inst.isActive} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => openEdit(inst)}
                        className="text-sm text-sh-blue hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Modal */}
      {editModal && (
        <Modal
          title="Edit Installer"
          onClose={() => setEditModal(null)}
          onSave={handleEdit}
          saving={editSaving}
        >
          <FormInput
            label="Name"
            name="editName"
            value={editForm.name}
            onChange={(v) => setEditForm((f) => ({ ...f, name: v }))}
            required
          />
          <FormInput
            label="Company (blank for in-house)"
            name="editCompany"
            value={editForm.company}
            onChange={(v) => setEditForm((f) => ({ ...f, company: v }))}
          />
          <FormInput
            label="Phone"
            name="editPhone"
            value={editForm.phone}
            onChange={(v) => setEditForm((f) => ({ ...f, phone: v }))}
          />
          <FormInput
            label="Email"
            name="editEmail"
            value={editForm.email}
            onChange={(v) => setEditForm((f) => ({ ...f, email: v }))}
          />
          <div className="mb-3">
            <label htmlFor="editNotes" className="block text-xs font-medium text-sh-gray mb-1">
              Notes
            </label>
            <textarea
              id="editNotes"
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              rows={2}
              value={editForm.notes}
              onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="editActive"
              checked={editForm.isActive}
              onChange={(e) => setEditForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="editActive" className="text-sm text-sh-gray">
              Active
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
