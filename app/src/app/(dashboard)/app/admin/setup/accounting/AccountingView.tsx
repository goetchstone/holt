"use client";

// /app/src/app/(dashboard)/app/admin/setup/accounting/AccountingView.tsx
//
// Chart of Accounts body. App Router port of the legacy admin/setup/accounting
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Edits
// GL accounts, account groups, and system GL mappings via the shared
// /api/accounting/* REST endpoints.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import GLAccountModal from "@/components/modals/GLAccountModal";
import AccountGroupModal from "@/components/modals/AccountGroupModal";
import { getErrorMessage } from "@/lib/toastError";

interface GLAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
  isActive: boolean;
  _count: { taxDistricts: number; accountGroups: number };
}

interface AccountRef {
  code: string;
  name: string;
}

interface AccountGroup {
  id: number;
  name: string;
  description: string | null;
  cogsAccountId: number | null;
  inventoryAccountId: number | null;
  salesAccountId: number | null;
  returnsAccountId: number | null;
  transfersAccountId: number | null;
  shrinkageAccountId: number | null;
  cogsAccount: AccountRef | null;
  inventoryAccount: AccountRef | null;
  salesAccount: AccountRef | null;
  returnsAccount: AccountRef | null;
  transfersAccount: AccountRef | null;
  shrinkageAccount: AccountRef | null;
}

interface SystemMapping {
  id: number;
  section: string;
  label: string;
  glAccountId: number | null;
  glAccount: { id: number; code: string; name: string } | null;
}

const SECTION_LABELS: Record<string, string> = {
  POS_PAYMENTS: "POS Payments",
  POS_TRANSACTIONS: "POS Transactions",
  AR_TRANSACTIONS: "AR Transactions",
  INVENTORY_TRANSACTIONS: "Inventory Transactions",
};

function formatAccount(acct: AccountRef | null) {
  return acct ? `${acct.code} - ${acct.name}` : "-";
}

function GLAccountsTab({
  glAccounts,
  onAdd,
  onEdit,
}: {
  glAccounts: GLAccount[];
  onAdd: () => void;
  onEdit: (account: GLAccount) => void;
}) {
  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-sh-blue">GL Accounts</h2>
        <Button onClick={onAdd}>+ Add Account</Button>
      </div>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-sh-gray/30">
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Code</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Name</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Type</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">References</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Status</th>
          </tr>
        </thead>
        <tbody>
          {glAccounts.map((a) => (
            <tr
              key={a.id}
              onClick={() => onEdit(a)}
              className="border-b border-sh-gray/10 hover:bg-sh-linen cursor-pointer"
            >
              <td className="py-2 px-3 font-medium">{a.code}</td>
              <td className="py-2 px-3">{a.name}</td>
              <td className="py-2 px-3">{a.accountType}</td>
              <td className="py-2 px-3 text-center">
                {a._count.taxDistricts + a._count.accountGroups}
              </td>
              <td className="py-2 px-3 text-center">
                <span
                  className={`text-xs px-2 py-0.5 rounded ${a.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}
                >
                  {a.isActive ? "Active" : "Inactive"}
                </span>
              </td>
            </tr>
          ))}
          {glAccounts.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-sh-gray">
                No GL accounts configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function AccountGroupsTab({
  accountGroups,
  onAdd,
  onEdit,
}: {
  accountGroups: AccountGroup[];
  onAdd: () => void;
  onEdit: (group: AccountGroup) => void;
}) {
  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-sh-blue">Account Groups</h2>
        <Button onClick={onAdd}>+ Add Group</Button>
      </div>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-sh-gray/30">
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Name</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">COGS</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Inventory</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Sales</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Returns</th>
          </tr>
        </thead>
        <tbody>
          {accountGroups.map((g) => (
            <tr
              key={g.id}
              onClick={() => onEdit(g)}
              className="border-b border-sh-gray/10 hover:bg-sh-linen cursor-pointer"
            >
              <td className="py-2 px-3 font-medium">{g.name}</td>
              <td className="py-2 px-3 text-sm text-sh-gray">{formatAccount(g.cogsAccount)}</td>
              <td className="py-2 px-3 text-sm text-sh-gray">
                {formatAccount(g.inventoryAccount)}
              </td>
              <td className="py-2 px-3 text-sm text-sh-gray">{formatAccount(g.salesAccount)}</td>
              <td className="py-2 px-3 text-sm text-sh-gray">{formatAccount(g.returnsAccount)}</td>
            </tr>
          ))}
          {accountGroups.length === 0 && (
            <tr>
              <td colSpan={5} className="py-8 text-center text-sh-gray">
                No account groups configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function SystemMappingSection({
  section,
  rows,
  glAccounts,
  onChange,
}: {
  section: string;
  rows: SystemMapping[];
  glAccounts: GLAccount[];
  onChange: (mappingId: number, glAccountId: string) => void;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-sh-blue mb-3">{SECTION_LABELS[section]}</h3>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-sh-gray/30">
            <th className="py-2 px-3 text-sh-gray text-sm font-medium w-1/3">Label</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">GL Account</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const selectId = `system-mapping-${m.id}`;
            return (
              <tr key={m.id} className="border-b border-sh-gray/10">
                <td className="py-2 px-3 font-medium">
                  <label htmlFor={selectId}>{m.label}</label>
                </td>
                <td className="py-2 px-3">
                  <select
                    id={selectId}
                    value={m.glAccountId?.toString() || ""}
                    onChange={(e) => onChange(m.id, e.target.value)}
                    className="w-full border border-sh-gray/30 rounded px-2 py-1.5 text-sm font-serif"
                  >
                    <option value="">-- None --</option>
                    {glAccounts.map((a) => (
                      <option key={a.id} value={a.id.toString()}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SystemAccountsTab({
  systemMappings,
  mappingsBySection,
  sections,
  glAccounts,
  onChange,
}: {
  systemMappings: SystemMapping[];
  mappingsBySection: Record<string, SystemMapping[]>;
  sections: string[];
  glAccounts: GLAccount[];
  onChange: (mappingId: number, glAccountId: string) => void;
}) {
  return (
    <>
      <h2 className="text-xl font-semibold text-sh-blue mb-2">System Account Mappings</h2>
      <p className="text-sm text-sh-gray mb-6">
        GL account assignments for POS payments, transaction postings, AR, and inventory
        adjustments. These are set during the nominal codes import and can be adjusted here.
      </p>

      {systemMappings.length === 0 ? (
        <p className="py-8 text-center text-sh-gray">
          No system mappings configured. Run the Nominal Codes import to populate defaults.
        </p>
      ) : (
        <div className="space-y-8">
          {sections.map((section) => {
            const rows = mappingsBySection[section];
            if (!rows || rows.length === 0) return null;
            return (
              <SystemMappingSection
                key={section}
                section={section}
                rows={rows}
                glAccounts={glAccounts}
                onChange={onChange}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

export function AccountingView() {
  const [glAccounts, setGlAccounts] = useState<GLAccount[]>([]);
  const [accountGroups, setAccountGroups] = useState<AccountGroup[]>([]);
  const [systemMappings, setSystemMappings] = useState<SystemMapping[]>([]);

  const [glModal, setGlModal] = useState<GLAccount | null | false>(false);
  const [groupModal, setGroupModal] = useState<AccountGroup | null | false>(false);

  const fetchGlAccounts = useCallback(async () => {
    const res = await fetch("/api/accounting/gl-accounts");
    if (res.ok) setGlAccounts(await res.json());
  }, []);

  const fetchAccountGroups = useCallback(async () => {
    const res = await fetch("/api/accounting/account-groups");
    if (res.ok) setAccountGroups(await res.json());
  }, []);

  const fetchSystemMappings = useCallback(async () => {
    const res = await fetch("/api/accounting/system-gl-mappings");
    if (res.ok) setSystemMappings(await res.json());
  }, []);

  useEffect(() => {
    fetchGlAccounts();
    fetchAccountGroups();
    fetchSystemMappings();
  }, [fetchGlAccounts, fetchAccountGroups, fetchSystemMappings]);

  const handleMappingChange = async (mappingId: number, glAccountId: string) => {
    try {
      const res = await fetch("/api/accounting/system-gl-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: mappingId, glAccountId: glAccountId || null }),
      });
      if (res.ok) {
        const updated = (await res.json()) as SystemMapping;
        setSystemMappings((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      } else {
        toast.error("Failed to update mapping");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update mapping"));
    }
  };

  const sections = Object.keys(SECTION_LABELS);
  const mappingsBySection = sections.reduce<Record<string, SystemMapping[]>>((acc, section) => {
    acc[section] = systemMappings.filter((m) => m.section === section);
    return acc;
  }, {});

  return (
    <div className="py-8 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-6">Chart of Accounts</h1>

      <Tabs defaultValue="gl-accounts">
        <TabsList>
          <TabsTrigger value="gl-accounts">GL Accounts</TabsTrigger>
          <TabsTrigger value="account-groups">Account Groups</TabsTrigger>
          <TabsTrigger value="system-accounts">System Accounts</TabsTrigger>
        </TabsList>

        <TabsContent tabValue="gl-accounts">
          <GLAccountsTab
            glAccounts={glAccounts}
            onAdd={() => setGlModal(null)}
            onEdit={(a) => setGlModal(a)}
          />
        </TabsContent>

        <TabsContent tabValue="account-groups">
          <AccountGroupsTab
            accountGroups={accountGroups}
            onAdd={() => setGroupModal(null)}
            onEdit={(g) => setGroupModal(g)}
          />
        </TabsContent>

        <TabsContent tabValue="system-accounts">
          <SystemAccountsTab
            systemMappings={systemMappings}
            mappingsBySection={mappingsBySection}
            sections={sections}
            glAccounts={glAccounts}
            onChange={handleMappingChange}
          />
        </TabsContent>
      </Tabs>

      {glModal !== false && (
        <GLAccountModal
          item={glModal}
          onClose={() => setGlModal(false)}
          onRefresh={() => {
            fetchGlAccounts();
            fetchAccountGroups();
          }}
        />
      )}

      {groupModal !== false && (
        <AccountGroupModal
          item={groupModal}
          glAccounts={glAccounts}
          onClose={() => setGroupModal(false)}
          onRefresh={fetchAccountGroups}
        />
      )}
    </div>
  );
}
