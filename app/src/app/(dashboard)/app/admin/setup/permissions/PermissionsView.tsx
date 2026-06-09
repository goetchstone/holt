"use client";

// /app/src/app/(dashboard)/app/admin/setup/permissions/PermissionsView.tsx
//
// Nav Permissions body. App Router port of the legacy admin/setup/permissions
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Edits
// the role-by-nav-section matrix via the shared /api/admin/permissions REST
// endpoint.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/lib/auth/navPermissions";
import { getErrorMessage } from "@/lib/toastError";

const ROLES = ["ADMIN", "MANAGER", "DESIGNER", "REGISTER", "WAREHOUSE", "MARKETING"] as const;
const NAV_LABELS = NAV_ITEMS.map((item) => item.label);

type PermissionMatrix = Record<string, Set<string>>;

function buildMatrix(permissions: { navItem: string; role: string }[]): PermissionMatrix {
  const matrix: PermissionMatrix = {};
  for (const label of NAV_LABELS) {
    matrix[label] = new Set();
  }
  for (const p of permissions) {
    if (matrix[p.navItem]) {
      matrix[p.navItem].add(p.role);
    }
  }
  return matrix;
}

function matrixToPermissions(matrix: PermissionMatrix): { navItem: string; role: string }[] {
  const result: { navItem: string; role: string }[] = [];
  for (const [navItem, roles] of Object.entries(matrix)) {
    for (const role of roles) {
      result.push({ navItem, role });
    }
  }
  return result;
}

export function PermissionsView() {
  const [matrix, setMatrix] = useState<PermissionMatrix>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchPermissions = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/permissions");
      if (res.ok) {
        const data = await res.json();
        setMatrix(buildMatrix(data.permissions));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load permissions"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  const togglePermission = (navItem: string, role: string) => {
    setMatrix((prev) => {
      const next = { ...prev };
      const roles = new Set(next[navItem]);
      if (roles.has(role)) {
        roles.delete(role);
      } else {
        roles.add(role);
      }
      next[navItem] = roles;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: matrixToPermissions(matrix) }),
      });
      if (res.ok) {
        toast.success("Permissions saved");
      } else {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(err?.error || "Save failed");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-2 font-serif space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue mb-1">Nav Permissions</h1>
          <p className="text-sh-gray text-sm">
            Control which navigation sections each role can access. Manager access cannot be
            removed.
          </p>
        </div>
        <Button variant="primary" onClick={handleSave} disabled={saving || loading}>
          {saving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          Save Changes
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading permissions...</span>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-sh-linen border-b border-gray-200">
                <th className="text-left px-4 py-3 font-semibold text-sh-blue">Nav Section</th>
                {ROLES.map((role) => (
                  <th key={role} className="text-center px-4 py-3 font-semibold text-sh-blue">
                    {role.charAt(0) + role.slice(1).toLowerCase()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NAV_LABELS.map((label) => (
                <tr
                  key={label}
                  className="border-b border-gray-100 last:border-0 hover:bg-sh-linen/50 transition"
                >
                  <td className="px-4 py-3 font-serif text-sh-black font-semibold">{label}</td>
                  {ROLES.map((role) => {
                    const checked = matrix[label]?.has(role) || false;
                    const inputId = `perm-${label}-${role}`;
                    return (
                      <td key={role} className="text-center px-4 py-3">
                        <label htmlFor={inputId} className="sr-only">
                          {role} access to {label}
                        </label>
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePermission(label, role)}
                          className="w-5 h-5 accent-sh-blue cursor-pointer"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
