"use client";

// /app/src/app/(dashboard)/app/admin/staff/StaffView.tsx
//
// Staff Management body. App Router port of the legacy admin/staff page (minus
// MainLayout chrome, supplied by the (dashboard) layout). View / add / edit /
// deactivate staff, seed from company data, and set a local sign-in password.
// Talks to the shared /api/staff + /api/admin/staff REST endpoints. Role gating
// for the password action uses the impersonation-aware effective role.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { Plus, Pencil, UserCheck, UserX, Users, Loader2, X, Save, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStoreLocations } from "@/hooks/useStoreLocations";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";

const ROLES = ["ADMIN", "DESIGNER", "REGISTER", "MANAGER", "WAREHOUSE", "MARKETING"] as const;

interface StaffMember {
  id: number;
  displayName: string;
  email: string | null;
  role: string;
  defaultStore: string | null;
  isActive: boolean;
  isDesigner: boolean;
  userId: string | null;
  user: { email: string; name: string | null; image: string | null } | null;
  commissionPlanId: number | null;
  commissionPlan: { id: number; name: string } | null;
}

interface CommissionPlanOption {
  id: number;
  name: string;
}

interface FormData {
  displayName: string;
  email: string;
  role: string;
  defaultStore: string;
  isDesigner: boolean;
  commissionPlanId: number | null;
}

interface StoreGroup {
  label: string;
  members: StaffMember[];
}

const emptyForm: FormData = {
  displayName: "",
  email: "",
  role: "DESIGNER",
  defaultStore: "",
  isDesigner: true,
  commissionPlanId: null,
};

function titleCaseRole(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

// Role -> badge classes. A lookup table beats the deeply nested ternary the
// legacy markup used; unknown roles fall back to the neutral gray.
function roleBadgeClass(role: string): string {
  switch (role) {
    case "ADMIN":
    case "SUPER_ADMIN":
      return "bg-red-100 text-red-700";
    case "DESIGNER":
      return "bg-sh-blue/10 text-sh-blue";
    case "MANAGER":
      return "bg-sh-gold/20 text-sh-gold";
    case "WAREHOUSE":
      return "bg-green-100 text-green-700";
    default:
      return "bg-gray-100 text-sh-gray";
  }
}

function StaffRow({
  member,
  isAdmin,
  onEdit,
  onSetPassword,
  onToggleActive,
}: Readonly<{
  member: StaffMember;
  isAdmin: boolean;
  onEdit: (m: StaffMember) => void;
  onSetPassword: (m: StaffMember) => void;
  onToggleActive: (m: StaffMember) => void;
}>) {
  return (
    <tr
      className={`border-b border-gray-100 last:border-0 hover:bg-sh-linen/50 transition ${
        member.isActive ? "" : "opacity-50"
      }`}
    >
      <td className="px-4 py-2.5 font-serif text-sh-black">{member.displayName}</td>
      <td className="px-4 py-2.5 text-sh-gray font-mono text-xs">{member.email || "—"}</td>
      <td className="px-4 py-2.5">
        <span
          className={`text-xs font-sans uppercase tracking-wider px-2 py-0.5 rounded-sm ${roleBadgeClass(
            member.role,
          )}`}
        >
          {member.role}
        </span>
        {member.isDesigner && (
          <span
            className="ml-1.5 text-[10px] font-sans uppercase tracking-wider text-green-700"
            title="Appears on designer-based sales + commission reports"
          >
            • designer
          </span>
        )}
        {member.commissionPlan && (
          <span
            className="ml-1.5 text-[10px] font-sans uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-sh-gold/15 text-sh-gold"
            title="Assigned commission plan"
          >
            {member.commissionPlan.name}
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs text-sh-gray">
        {member.user ? (
          <span className="flex items-center gap-1.5">
            <UserCheck className="w-3.5 h-3.5 text-green-500" />
            {member.user.email}
          </span>
        ) : (
          <span className="text-sh-gray/50 italic">Not linked</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-center">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            member.isActive ? "bg-green-400" : "bg-gray-300"
          }`}
          title={member.isActive ? "Active" : "Inactive"}
        />
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => onEdit(member)}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-sh-gray hover:text-sh-blue active:text-sh-blue transition rounded"
            title="Edit"
          >
            <Pencil className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button
              onClick={() => onSetPassword(member)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-sh-gray hover:text-sh-blue active:text-sh-blue transition rounded"
              title="Set password"
            >
              <KeyRound className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onToggleActive(member)}
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center transition rounded ${
              member.isActive
                ? "text-sh-gray hover:text-red-500 active:text-red-500"
                : "text-sh-gray hover:text-green-500 active:text-green-500"
            }`}
            title={member.isActive ? "Deactivate" : "Reactivate"}
          >
            {member.isActive ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
          </button>
        </div>
      </td>
    </tr>
  );
}

function StaffCard({
  member,
  isAdmin,
  onEdit,
  onSetPassword,
  onToggleActive,
}: Readonly<{
  member: StaffMember;
  isAdmin: boolean;
  onEdit: (m: StaffMember) => void;
  onSetPassword: (m: StaffMember) => void;
  onToggleActive: (m: StaffMember) => void;
}>) {
  return (
    <div
      className={`bg-white border border-gray-200 rounded-lg p-4 ${
        member.isActive ? "" : "opacity-50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-serif text-sh-black text-sm font-semibold truncate">
              {member.displayName}
            </span>
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                member.isActive ? "bg-green-400" : "bg-gray-300"
              }`}
            />
          </div>
          <span
            className={`text-xs font-sans uppercase tracking-wider px-2 py-0.5 rounded-sm ${roleBadgeClass(
              member.role,
            )}`}
          >
            {member.role}
          </span>
          {member.email && <p className="text-sh-gray text-xs mt-1.5 truncate">{member.email}</p>}
        </div>
        <div className="flex items-center gap-0">
          <button
            onClick={() => onEdit(member)}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-sh-gray active:text-sh-blue transition rounded"
            title="Edit"
          >
            <Pencil className="w-5 h-5" />
          </button>
          {isAdmin && (
            <button
              onClick={() => onSetPassword(member)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-sh-gray active:text-sh-blue transition rounded"
              title="Set password"
            >
              <KeyRound className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => onToggleActive(member)}
            className={`min-w-[44px] min-h-[44px] flex items-center justify-center transition rounded ${
              member.isActive
                ? "text-sh-gray active:text-red-500"
                : "text-sh-gray active:text-green-500"
            }`}
            title={member.isActive ? "Deactivate" : "Reactivate"}
          >
            {member.isActive ? <UserX className="w-5 h-5" /> : <UserCheck className="w-5 h-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function StaffGroup({
  group,
  isAdmin,
  onEdit,
  onSetPassword,
  onToggleActive,
}: Readonly<{
  group: StoreGroup;
  isAdmin: boolean;
  onEdit: (m: StaffMember) => void;
  onSetPassword: (m: StaffMember) => void;
  onToggleActive: (m: StaffMember) => void;
}>) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-sans uppercase tracking-[0.2em] text-sh-gray mt-4 mb-2">
        {group.label}
      </h3>

      {/* Desktop table -- hidden on small screens */}
      <div className="hidden sm:block bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-sh-linen border-b border-gray-200">
              <th className="text-left px-4 py-2 font-semibold text-sh-blue">Name</th>
              <th className="text-left px-4 py-2 font-semibold text-sh-blue">Email</th>
              <th className="text-left px-4 py-2 font-semibold text-sh-blue">Role</th>
              <th className="text-left px-4 py-2 font-semibold text-sh-blue">Google Account</th>
              <th className="text-center px-4 py-2 font-semibold text-sh-blue">Status</th>
              <th className="text-right px-4 py-2 font-semibold text-sh-blue">Actions</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => (
              <StaffRow
                key={m.id}
                member={m}
                isAdmin={isAdmin}
                onEdit={onEdit}
                onSetPassword={onSetPassword}
                onToggleActive={onToggleActive}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card layout -- visible only on small screens */}
      <div className="sm:hidden space-y-2">
        {group.members.map((m) => (
          <StaffCard
            key={m.id}
            member={m}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onSetPassword={onSetPassword}
            onToggleActive={onToggleActive}
          />
        ))}
      </div>
    </div>
  );
}

function StaffFormModal({
  editingId,
  form,
  isAdmin,
  storeNames,
  commissionPlans,
  saving,
  onChange,
  onClose,
  onSave,
}: Readonly<{
  editingId: number | null;
  form: FormData;
  isAdmin: boolean;
  storeNames: string[];
  commissionPlans: CommissionPlanOption[] | null;
  saving: boolean;
  onChange: (next: FormData) => void;
  onClose: () => void;
  onSave: () => void;
}>) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="bg-white rounded-t-lg sm:rounded-lg shadow-xl w-full sm:max-w-md sm:mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-sh-blue">
            {editingId ? "Edit Staff Member" : "Add Staff Member"}
          </h2>
          <button
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-sh-gray active:text-sh-black transition -mr-2"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="staff-display-name"
              className="block text-sm font-semibold text-sh-blue mb-1"
            >
              Display Name *
            </label>
            <input
              id="staff-display-name"
              type="text"
              value={form.displayName}
              onChange={(e) => onChange({ ...form, displayName: e.target.value })}
              className="w-full border border-sh-gray rounded-lg px-3 py-3 text-base sm:py-2 sm:text-sm"
              placeholder="e.g. Jordan Lee"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="staff-email" className="block text-sm font-semibold text-sh-blue mb-1">
              Email
            </label>
            <input
              id="staff-email"
              type="email"
              value={form.email}
              onChange={(e) => onChange({ ...form, email: e.target.value })}
              className="w-full border border-sh-gray rounded-lg px-3 py-3 text-base sm:py-2 sm:text-sm"
              placeholder="name@company.com"
            />
            <p className="text-xs text-sh-gray mt-1">Used to auto-link with their Google sign-in</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="staff-role" className="block text-sm font-semibold text-sh-blue mb-1">
                Role
              </label>
              <select
                id="staff-role"
                value={form.role}
                onChange={(e) => onChange({ ...form, role: e.target.value })}
                disabled={!isAdmin}
                className="w-full border border-sh-gray rounded-lg px-3 py-3 text-base sm:py-2 sm:text-sm bg-white appearance-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {titleCaseRole(r)}
                  </option>
                ))}
              </select>
              {!isAdmin && (
                <p className="text-xs text-sh-gray mt-1">Only admins can change roles</p>
              )}
            </div>
            <div>
              <label
                htmlFor="staff-store"
                className="block text-sm font-semibold text-sh-blue mb-1"
              >
                Default Store
              </label>
              <select
                id="staff-store"
                value={form.defaultStore}
                onChange={(e) => onChange({ ...form, defaultStore: e.target.value })}
                className="w-full border border-sh-gray rounded-lg px-3 py-3 text-base sm:py-2 sm:text-sm bg-white appearance-none"
              >
                <option value="">None</option>
                {storeNames.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label
            htmlFor="staff-is-designer"
            className="flex items-center gap-2 text-sm text-sh-black cursor-pointer mt-3"
          >
            <input
              id="staff-is-designer"
              type="checkbox"
              checked={form.isDesigner}
              onChange={(e) => onChange({ ...form, isDesigner: e.target.checked })}
              className="accent-sh-blue w-4 h-4"
            />
            <span>Show on designer-based sales &amp; commission reports</span>
          </label>

          {/* Hidden when the plans fetch was denied (non-SUPER_ADMIN viewer). */}
          {commissionPlans !== null && (
            <div>
              <label
                htmlFor="staff-commission-plan"
                className="block text-sm font-semibold text-sh-blue mb-1"
              >
                Commission plan
              </label>
              <select
                id="staff-commission-plan"
                value={form.commissionPlanId === null ? "" : String(form.commissionPlanId)}
                onChange={(e) =>
                  onChange({
                    ...form,
                    commissionPlanId: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className="w-full border border-sh-gray rounded-lg px-3 py-3 text-base sm:py-2 sm:text-sm bg-white appearance-none"
              >
                <option value="">Default</option>
                {commissionPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-sh-gray mt-1">
                &ldquo;Default&rdquo; follows the default plan (or the standard tiers)
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            {editingId ? "Save Changes" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetPasswordModal({
  target,
  value,
  saving,
  onChange,
  onClose,
  onSave,
}: Readonly<{
  target: StaffMember;
  value: string;
  saving: boolean;
  onChange: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
}>) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 font-serif shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-sh-blue">Set Password</h3>
          <button
            onClick={onClose}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center text-sh-gray hover:text-sh-black"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-sh-gray">
          Set a local sign-in password for{" "}
          <span className="font-semibold text-sh-black">{target.displayName}</span>. They can sign
          in with their email and this password when local accounts are enabled.
        </p>
        <label htmlFor="set-password" className="mb-1 block text-sm font-medium text-sh-navy">
          New Password
        </label>
        <input
          id="set-password"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="At least 8 characters"
          className="mb-4 min-h-[44px] w-full rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" />
                Set Password
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function StaffView() {
  const { effectiveRole } = useEffectiveRole();
  const isAdmin = effectiveRole === "ADMIN" || effectiveRole === "SUPER_ADMIN";

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Configured store locations for the assignment dropdown (DB-driven).
  const { stores: storeOptions } = useStoreLocations({ type: "STORE" });

  // Edit/Add modal state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [saving, setSaving] = useState(false);

  // Set-password modal state (local email+password sign-in)
  const [pwTarget, setPwTarget] = useState<StaffMember | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  // Commission plans for the assignment dropdown. The endpoint is
  // SUPER_ADMIN-only while this page also renders for MANAGER/ADMIN, so a
  // 401/403 (or any failure) keeps this null and the dropdown stays hidden.
  const [commissionPlans, setCommissionPlans] = useState<CommissionPlanOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadPlans = async () => {
      try {
        const res = await fetch("/api/admin/reports/commission-tiers/tiers");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.plans)) {
          setCommissionPlans(
            data.plans.map((p: { id: number; name: string }) => ({ id: p.id, name: p.name })),
          );
        }
      } catch {
        // Deliberately silent: lacking plan access just hides the dropdown.
      }
    };
    loadPlans();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/staff?all=true");
      if (res.ok) setStaff(await res.json());
    } catch {
      toast.error("Failed to load staff");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const res = await fetch("/api/staff/seed", { method: "POST" });
      const data = await res.json();
      toast.success(`Seeded ${data.created} new staff (${data.existing} already existed)`);
      fetchStaff();
    } catch {
      toast.error("Failed to seed staff");
    } finally {
      setSeeding(false);
    }
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditingId(member.id);
    setForm({
      displayName: member.displayName,
      email: member.email || "",
      role: member.role,
      defaultStore: member.defaultStore || "",
      isDesigner: member.isDesigner,
      commissionPlanId: member.commissionPlanId ?? null,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.displayName.trim()) {
      toast.error("Display name is required");
      return;
    }
    setSaving(true);
    try {
      const url = editingId ? `/api/staff/${editingId}` : "/api/staff";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.displayName.trim(),
          email: form.email.trim() || null,
          role: form.role,
          defaultStore: form.defaultStore || null,
          isDesigner: form.isDesigner,
          commissionPlanId: form.commissionPlanId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Save failed");
        return;
      }
      toast.success(editingId ? "Staff member updated" : "Staff member created");
      setShowForm(false);
      fetchStaff();
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const openSetPassword = (member: StaffMember) => {
    setPwTarget(member);
    setPwValue("");
  };

  const handleSetPassword = async () => {
    if (!pwTarget) return;
    if (pwValue.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch(`/api/admin/staff/${pwTarget.id}/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwValue }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to set password");
        return;
      }
      toast.success(`Password set for ${pwTarget.displayName}`);
      setPwTarget(null);
      setPwValue("");
      fetchStaff();
    } catch {
      toast.error("Failed to set password");
    } finally {
      setPwSaving(false);
    }
  };

  const toggleActive = async (member: StaffMember) => {
    try {
      const res = await fetch(`/api/staff/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !member.isActive }),
      });
      if (res.ok) {
        toast.success(
          member.isActive
            ? `${member.displayName} deactivated`
            : `${member.displayName} reactivated`,
        );
        fetchStaff();
      }
    } catch {
      toast.error("Failed to update status");
    }
  };

  const displayedStaff = showInactive ? staff : staff.filter((s) => s.isActive);

  // Store names come from the configured StoreLocation table, plus any legacy
  // defaultStore values already on staff rows that aren't in the current list
  // (so nobody disappears if a store was renamed/removed).
  const storeNames = useMemo(() => {
    const names = new Set<string>(storeOptions.map((s) => s.name));
    for (const s of staff) {
      if (s.defaultStore) names.add(s.defaultStore);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [storeOptions, staff]);

  const storeGroups = useMemo<StoreGroup[]>(() => {
    const byStore = (store: string | null) =>
      displayedStaff.filter((s) => s.defaultStore === store);
    return [
      ...storeNames.map((s) => ({ label: s, members: byStore(s) })),
      { label: "No Store Assigned", members: byStore(null) },
    ].filter((g) => g.members.length > 0);
  }, [displayedStaff, storeNames]);

  return (
    <div className="py-2 font-serif space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue mb-1">Staff Members</h1>
          <p className="text-sh-gray text-sm">
            Manage designers, register staff, and managers for the up-board rotation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={handleSeed} disabled={seeding}>
            {seeding ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Users className="w-4 h-4 mr-2" />
            )}
            Seed Staff
          </Button>
          <Button variant="primary" onClick={openAdd}>
            <Plus className="w-4 h-4 mr-2" /> Add Staff
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <label
          htmlFor="show-inactive"
          className="flex items-center gap-2 text-sm text-sh-gray cursor-pointer"
        >
          <input
            id="show-inactive"
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="accent-sh-blue w-4 h-4"
          />
          Show inactive staff
        </label>
        <span className="text-sm text-sh-gray">
          {displayedStaff.length} staff member{displayedStaff.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading staff...</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && displayedStaff.length === 0 && (
        <div className="text-center py-16 text-sh-gray">
          <p>No staff members found.</p>
          <p className="text-sm mt-2">
            Click &ldquo;Seed Staff&rdquo; to populate from company data, or add staff manually.
          </p>
        </div>
      )}

      {/* Staff grouped by store */}
      {!loading &&
        storeGroups.map((group) => (
          <StaffGroup
            key={group.label}
            group={group}
            isAdmin={isAdmin}
            onEdit={openEdit}
            onSetPassword={openSetPassword}
            onToggleActive={toggleActive}
          />
        ))}

      {/* Add/Edit form modal */}
      {showForm && (
        <StaffFormModal
          editingId={editingId}
          form={form}
          isAdmin={isAdmin}
          storeNames={storeNames}
          commissionPlans={commissionPlans}
          saving={saving}
          onChange={setForm}
          onClose={() => setShowForm(false)}
          onSave={handleSave}
        />
      )}

      {/* Set-password modal (local email+password sign-in) */}
      {pwTarget && (
        <SetPasswordModal
          target={pwTarget}
          value={pwValue}
          saving={pwSaving}
          onChange={setPwValue}
          onClose={() => setPwTarget(null)}
          onSave={handleSetPassword}
        />
      )}
    </div>
  );
}
