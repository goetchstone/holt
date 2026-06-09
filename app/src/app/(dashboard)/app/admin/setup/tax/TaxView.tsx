"use client";

// /app/src/app/(dashboard)/app/admin/setup/tax/TaxView.tsx
//
// Tax Configuration body. App Router port of the legacy admin/setup/tax index
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Edits
// tax districts, groups, exempt reasons, and rules via the shared /api/tax/*
// REST endpoints. Tax rates are stored as fractions and shown as percentages
// (kept as-is, not money-formatted).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import TaxDistrictModal from "@/components/modals/TaxDistrictModal";
import TaxGroupModal from "@/components/modals/TaxGroupModal";
import TaxExemptReasonModal from "@/components/modals/TaxExemptReasonModal";
import TaxRuleModal from "@/components/modals/TaxRuleModal";

interface District {
  id: number;
  shortName: string;
  state: string;
  authority: string | null;
  name: string;
  reference: string | null;
  glAccountId: number | null;
  isActive: boolean;
  _count: { zipCodes: number; rules: number };
}

interface Group {
  id: number;
  name: string;
  taxBasis: string;
  freightTaxable: boolean;
  miscTaxable: boolean;
  _count: { rules: number };
}

interface ExemptReason {
  id: number;
  name: string;
  description: string | null;
  _count: { customers: number };
}

interface TaxRule {
  id: number;
  districtId: number;
  groupId: number;
  taxRate: number;
  triggerPrice: number | null;
  startPrice: number | null;
  stopPrice: number | null;
  triggerStop: number | null;
  taxIncludedInSalesPrice: boolean;
  ruleToAddBeforeCalcId: number | null;
  sortOrder: number;
  isActive: boolean;
  district: { shortName: string; name: string };
  group: { name: string };
}

function StatusBadge({ active }: { active: boolean }) {
  const cls = active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{active ? "Active" : "Inactive"}</span>
  );
}

export function TaxView() {
  const [districts, setDistricts] = useState<District[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [exemptReasons, setExemptReasons] = useState<ExemptReason[]>([]);
  const [rules, setRules] = useState<TaxRule[]>([]);

  const [districtModal, setDistrictModal] = useState<District | null | false>(false);
  const [groupModal, setGroupModal] = useState<Group | null | false>(false);
  const [exemptModal, setExemptModal] = useState<ExemptReason | null | false>(false);
  const [ruleModal, setRuleModal] = useState<TaxRule | null | false>(false);

  const fetchDistricts = useCallback(async () => {
    const res = await fetch("/api/tax/districts");
    if (res.ok) setDistricts(await res.json());
  }, []);

  const fetchGroups = useCallback(async () => {
    const res = await fetch("/api/tax/groups");
    if (res.ok) setGroups(await res.json());
  }, []);

  const fetchExemptReasons = useCallback(async () => {
    const res = await fetch("/api/tax/exempt-reasons");
    if (res.ok) setExemptReasons(await res.json());
  }, []);

  const fetchRules = useCallback(async () => {
    const res = await fetch("/api/tax/rules");
    if (res.ok) setRules(await res.json());
  }, []);

  useEffect(() => {
    fetchDistricts();
    fetchGroups();
    fetchExemptReasons();
    fetchRules();
  }, [fetchDistricts, fetchGroups, fetchExemptReasons, fetchRules]);

  return (
    <div className="py-8 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-6">Tax Configuration</h1>

      <Tabs defaultValue="districts">
        <TabsList>
          <TabsTrigger value="districts">Districts</TabsTrigger>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="exempt">Exempt Reasons</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>

        {/* Districts Tab */}
        <TabsContent tabValue="districts">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-sh-blue">Tax Districts</h2>
            <div className="flex gap-2">
              <Link href="/app/admin/setup/tax/load-zips">
                <Button variant="outline">Load Zip Codes</Button>
              </Link>
              <Button onClick={() => setDistrictModal(null)}>+ Add District</Button>
            </div>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-sh-gray/30">
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Short Name</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Name</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">State</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Authority</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">
                  ZIP Codes
                </th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Rules</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {districts.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => setDistrictModal(d)}
                  className="border-b border-sh-gray/10 hover:bg-sh-linen cursor-pointer"
                >
                  <td className="py-2 px-3 font-medium">{d.shortName}</td>
                  <td className="py-2 px-3">{d.name}</td>
                  <td className="py-2 px-3">{d.state}</td>
                  <td className="py-2 px-3 text-sh-gray">{d.authority || "-"}</td>
                  <td className="py-2 px-3 text-center">{d._count.zipCodes}</td>
                  <td className="py-2 px-3 text-center">{d._count.rules}</td>
                  <td className="py-2 px-3 text-center">
                    <StatusBadge active={d.isActive} />
                  </td>
                </tr>
              ))}
              {districts.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-sh-gray">
                    No tax districts configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TabsContent>

        {/* Groups Tab */}
        <TabsContent tabValue="groups">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-sh-blue">Tax Groups</h2>
            <Button onClick={() => setGroupModal(null)}>+ Add Group</Button>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-sh-gray/30">
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Name</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Tax Basis</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">
                  Freight Taxable
                </th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">
                  Misc Taxable
                </th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Rules</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr
                  key={g.id}
                  onClick={() => setGroupModal(g)}
                  className="border-b border-sh-gray/10 hover:bg-sh-linen cursor-pointer"
                >
                  <td className="py-2 px-3 font-medium">{g.name}</td>
                  <td className="py-2 px-3">{g.taxBasis}</td>
                  <td className="py-2 px-3 text-center">{g.freightTaxable ? "Yes" : "No"}</td>
                  <td className="py-2 px-3 text-center">{g.miscTaxable ? "Yes" : "No"}</td>
                  <td className="py-2 px-3 text-center">{g._count.rules}</td>
                </tr>
              ))}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sh-gray">
                    No tax groups configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TabsContent>

        {/* Exempt Reasons Tab */}
        <TabsContent tabValue="exempt">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-sh-blue">Tax Exempt Reasons</h2>
            <Button onClick={() => setExemptModal(null)}>+ Add Reason</Button>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-sh-gray/30">
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Name</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Description</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">
                  Customers
                </th>
              </tr>
            </thead>
            <tbody>
              {exemptReasons.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setExemptModal(r)}
                  className="border-b border-sh-gray/10 hover:bg-sh-linen cursor-pointer"
                >
                  <td className="py-2 px-3 font-medium">{r.name}</td>
                  <td className="py-2 px-3 text-sh-gray">{r.description || "-"}</td>
                  <td className="py-2 px-3 text-center">{r._count.customers}</td>
                </tr>
              ))}
              {exemptReasons.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-8 text-center text-sh-gray">
                    No exempt reasons configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TabsContent>

        {/* Rules Tab */}
        <TabsContent tabValue="rules">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-sh-blue">Tax Rules</h2>
            <Button onClick={() => setRuleModal(null)}>+ Add Rule</Button>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-sh-gray/30">
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">District</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium">Group</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-right">Rate</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Order</th>
                <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setRuleModal(r)}
                  className="border-b border-sh-gray/10 hover:bg-sh-linen cursor-pointer"
                >
                  <td className="py-2 px-3 font-medium">{r.district.shortName}</td>
                  <td className="py-2 px-3">{r.group.name}</td>
                  <td className="py-2 px-3 text-right">{(r.taxRate * 100).toFixed(2)}%</td>
                  <td className="py-2 px-3 text-center">{r.sortOrder}</td>
                  <td className="py-2 px-3 text-center">
                    <StatusBadge active={r.isActive} />
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sh-gray">
                    No tax rules configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TabsContent>
      </Tabs>

      {/* Modals */}
      {districtModal !== false && (
        <TaxDistrictModal
          item={districtModal}
          onClose={() => setDistrictModal(false)}
          onRefresh={() => {
            fetchDistricts();
            fetchRules();
          }}
        />
      )}

      {groupModal !== false && (
        <TaxGroupModal
          item={groupModal}
          onClose={() => setGroupModal(false)}
          onRefresh={() => {
            fetchGroups();
            fetchRules();
          }}
        />
      )}

      {exemptModal !== false && (
        <TaxExemptReasonModal
          item={exemptModal}
          onClose={() => setExemptModal(false)}
          onRefresh={fetchExemptReasons}
        />
      )}

      {ruleModal !== false && (
        <TaxRuleModal
          item={ruleModal}
          districts={districts}
          groups={groups}
          rules={rules}
          onClose={() => setRuleModal(false)}
          onRefresh={fetchRules}
        />
      )}
    </div>
  );
}
