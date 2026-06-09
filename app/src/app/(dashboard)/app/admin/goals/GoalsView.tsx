"use client";

// /app/src/app/(dashboard)/app/admin/goals/GoalsView.tsx
//
// Sales goals body. App Router port of the legacy admin/goals page (minus
// MainLayout chrome, supplied by the (dashboard) layout). Paginated, searchable
// list of company / department / category goals with a create + edit modal.
// Talks to the shared /api/goals REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import TableWithFilters from "@/components/table/TableWithFilters";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormNumberInput from "@/components/form/FormNumberInput";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface Goal {
  id: number;
  year: number;
  goalType: string;
  entityName: string;
  annualGoal: number;
}

type EditingState = Goal | null | "new";

const PAGE_SIZE = 10;

const COLUMNS = [
  { key: "year", label: "Year", accessor: "year" },
  { key: "goalType", label: "Type", accessor: "goalType" },
  { key: "entityName", label: "Name", accessor: "entityName" },
  { key: "annualGoal", label: "Annual Goal", accessor: "annualGoal" },
];

export function GoalsView() {
  const [allGoals, setAllGoals] = useState<Goal[]>([]);
  const [visible, setVisible] = useState<Goal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<EditingState>(null);
  const [formData, setFormData] = useState<Partial<Goal>>({});
  const [saving, setSaving] = useState(false);

  const paginate = useCallback((p: number, q: string, goals: Goal[]) => {
    const filtered = q
      ? goals.filter((g) => g.entityName.toLowerCase().includes(q.toLowerCase()))
      : goals;
    setTotal(filtered.length);
    setVisible(filtered.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE));
    setPage(p);
    setSearch(q);
  }, []);

  const loadGoals = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<Goal[]>("/api/goals");
      setAllGoals(res.data);
      paginate(1, search, res.data);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load goals."));
    } finally {
      setLoading(false);
    }
    // `search` intentionally omitted: re-running on every keystroke would refetch
    // the full list; pagination handles search-on-existing-data separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginate]);

  useEffect(() => {
    loadGoals();
  }, [loadGoals]);

  useEffect(() => {
    paginate(page, search, allGoals);
  }, [page, search, allGoals, paginate]);

  const openCreate = () => {
    setFormData({
      year: new Date().getFullYear(),
      goalType: "Department",
      entityName: "",
      annualGoal: 0,
    });
    setEditing("new");
  };

  const openEdit = (g: Goal) => {
    setFormData(g);
    setEditing(g);
  };

  const handleFormChange = (field: keyof Goal, value: string | number) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const saveGoal = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await axios.post("/api/goals", formData);
        toast.success("Goal created successfully!");
      } else {
        await axios.put("/api/goals", {
          id: formData.id,
          annualGoal: formData.annualGoal,
        });
        toast.success("Goal updated successfully!");
      }
      setEditing(null);
      await loadGoals();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save goal."));
    } finally {
      setSaving(false);
    }
  };

  const isNew = editing === "new";

  return (
    <>
      <div className="py-2 font-serif space-y-4">
        <div className="text-right">
          <Button onClick={openCreate}>+ New Goal</Button>
        </div>
        <TableWithFilters
          data={visible}
          total={total}
          page={page}
          loading={loading}
          columns={COLUMNS}
          searchFields={["entityName"]}
          storageKey="goals"
          onRowClick={openEdit}
          onPageChange={setPage}
          onSearchChange={(q) => {
            setPage(1);
            setSearch(q);
          }}
        />
      </div>
      {editing && (
        <Modal
          title={isNew ? "New Goal" : `Edit Goal – ${formData.entityName}`}
          onClose={() => setEditing(null)}
          onSave={saveGoal}
          saving={saving}
        >
          <FormNumberInput
            name="year"
            label="Year"
            value={formData.year || ""}
            onChange={(v) => handleFormChange("year", Number(v))}
            disabled={!isNew}
          />
          <FormInput
            name="goalType"
            label="Goal Type (Company / Department / Category)"
            value={formData.goalType || ""}
            onChange={(v) => handleFormChange("goalType", v)}
            disabled={!isNew}
          />
          <FormInput
            name="entityName"
            label="Entity Name"
            value={formData.entityName || ""}
            onChange={(v) => handleFormChange("entityName", v)}
            disabled={!isNew}
          />
          <FormNumberInput
            name="annualGoal"
            label="Annual Goal"
            value={formData.annualGoal || ""}
            onChange={(v) => handleFormChange("annualGoal", Number(v))}
          />
        </Modal>
      )}
    </>
  );
}
