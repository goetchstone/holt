"use client";

// /app/src/app/(dashboard)/app/sales/customers/[id]/CustomerDetailView.tsx
//
// Customer detail. App Router port of the legacy sales/customers/[id] body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Reads +
// writes the shared /api/customers/:id REST endpoints (detail, trade, addresses,
// email-stats) plus /api/admin/trade-tiers and /api/mailchimp/activities, which
// all stay REST. Wealth UI stays role-gated client-side via useEffectiveRole.
// The id arrives as a prop from the server page (params awaited there).

import { useState, useEffect, useCallback, useMemo } from "react";
import axios from "axios";
import type { Customer } from "@prisma/client";
import { Button } from "@/components/ui/button";
import CustomerEditModal from "@/components/modals/CustomerEditModal";
import { toast } from "react-toastify";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import Modal from "@/components/ui/Modal";
import Link from "next/link";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import PaginatedTable from "@/components/table/PaginatedTable";
import { format } from "date-fns";
import { parseLocalDate } from "@/lib/dateUtils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { WealthTierBadge } from "@/components/customer/WealthTierBadge";
import { LeadScoreBadge } from "@/components/customer/LeadScoreBadge";
import { calculateLeadScore } from "@/lib/leadScore";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { getErrorMessage } from "@/lib/toastError";

interface OrderLineItem {
  id: number;
  netPrice: number | null;
  vatAmount: number | null;
}

interface OrderPayment {
  id: number;
  paymentAmount: number | null;
}

interface SalesOrderRaw {
  id: number;
  orderno: string;
  orderDate: string | null;
  status: string;
  lineItems: OrderLineItem[];
  payments: OrderPayment[];
}

interface SalesOrderWithCalculatedFields extends SalesOrderRaw {
  calculatedOrderTotal: number;
  calculatedTotalPaid: number;
}

interface CustomerAddressRecord {
  id: number;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

interface TradeTier {
  id: number;
  name: string;
  discountPercent: number;
  isActive: boolean;
}

interface WindfallData {
  wealthTier: string | null;
  netWorth: number | null;
  netWorthLow: number | null;
  netWorthHigh: number | null;
  matchConfidence: number | null;
  windfallId: string | null;
  netWorthLastCalculated: string | null;
  recentMover: boolean;
  recentlyDivorced: boolean;
  recentDeathInFamily: boolean;
  boatOwner: boolean;
  planeOwner: boolean;
  multiPropertyOwner: boolean;
  rentalPropertyOwner: boolean;
  philanthropicGiver: boolean;
  smallBusinessOwner: boolean;
  politicalDonor: boolean;
  moneyInMotion: boolean;
  liquidityTrigger: boolean;
  recentMortgage: boolean;
}

interface CustomerWithRelations {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  customerLevel: number | null;
  peakCustomerLevel: number | null;
  customerGroup: string | null;
  lifetimeSpend: number | string | null;
  lifetimeOrderCount: number | null;
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  departmentCount: number | null;
  isTradeAccount: boolean;
  tradeTierId: number | null;
  tradeCompanyName: string | null;
  taxExemptNumber: string | null;
  addresses: CustomerAddressRecord[];
  externalIds: { id: number; externalId: string }[];
  salesOrders: SalesOrderWithCalculatedFields[];
  tradeTier: TradeTier | null;
  windfallEnrichment: WindfallData | null;
}

interface EmailStats {
  totalSent: number;
  totalOpens: number;
  openRate: number;
  totalClicks: number;
  clickRate: number;
}

interface EmailActivityRow {
  email: string;
  action: string;
  timestamp: string;
  campaignName: string | null;
}

interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

const LEVEL_CONFIG: Record<number, { label: string; className: string; description: string }> = {
  1: {
    label: "Occasional",
    className: "bg-sh-gray/20 text-sh-gray",
    description: "Below average order frequency and order total",
  },
  2: {
    label: "Frequent",
    className: "bg-sh-brand-blue/20 text-sh-brand-blue",
    description: "Above average order frequency, below average order total",
  },
  3: {
    label: "High Value",
    className: "bg-sh-gold/20 text-sh-gold",
    description: "Below average order frequency, above average order total",
  },
  4: {
    label: "VIP",
    className: "bg-green-100 text-green-800",
    description: "Above average order frequency and order total",
  },
};

// Current groups (as of the 2026-04-25 regroup) plus transitional labels for
// the legacy values the migration leaves behind until a Recalculate Levels run.
const GROUP_LABELS: Record<string, string> = {
  FURNITURE: "Furniture",
  HOME_ACC: "Home Accessories",
  APPAREL: "Apparel",
  CHRISTMAS: "Christmas",
  HOME: "Home (legacy — needs recalc)",
  LIFESTYLE: "Lifestyle (legacy — needs recalc)",
};

const EMAIL_ACTION_STYLES: Record<string, string> = {
  open: "bg-blue-50 text-blue-700",
  click: "bg-green-50 text-green-700",
  bounce: "bg-red-50 text-red-700",
};

function emailActionStyle(action: string): string {
  return EMAIL_ACTION_STYLES[action] || "bg-gray-50 text-gray-700";
}

function CustomerLevelBadge({
  level,
  peak,
  group,
}: {
  level: number | null | undefined;
  peak: number | null | undefined;
  group: string | null | undefined;
}) {
  const isDormant = !level && peak && LEVEL_CONFIG[peak];
  const isDowngraded = level && peak && peak > level && LEVEL_CONFIG[peak];

  if (!level && !isDormant) return null;

  const groupLabel = group ? ` (${group})` : "";

  if (isDormant && LEVEL_CONFIG[peak!]) {
    const peakConfig = LEVEL_CONFIG[peak!];
    return (
      <span
        className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700"
        title={`Was ${peakConfig.label}${groupLabel} — no recent orders in window`}
      >
        Dormant — was {peakConfig.label}
      </span>
    );
  }

  if (level && LEVEL_CONFIG[level]) {
    const config = LEVEL_CONFIG[level];
    const peakNote =
      isDowngraded && LEVEL_CONFIG[peak!] ? ` (Peak: ${LEVEL_CONFIG[peak!].label})` : "";
    return (
      <span
        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${config.className}`}
        title={`Level ${level}: ${config.description}${groupLabel}${peakNote}`}
      >
        {config.label}
        {peakNote}
      </span>
    );
  }

  return null;
}

// Lead score is safe for all roles; only the tier label is always shown.
// Managers/admin/marketing also see the numeric score. Life-event signals boost
// the score even for designers who can't see the raw wealth tier -- the signal
// is "this customer is more likely to buy right now," which is role-safe.
function CustomerLeadScore({
  customer,
  effectiveRole,
  canSeeWealth,
}: {
  customer: CustomerWithRelations;
  effectiveRole: string;
  canSeeWealth: boolean;
}) {
  const wf = customer.windfallEnrichment;
  const score = calculateLeadScore({
    lifetimeSpend: Number(customer.lifetimeSpend ?? 0),
    lifetimeOrderCount: customer.lifetimeOrderCount,
    customerLevel: customer.customerLevel,
    peakCustomerLevel: customer.peakCustomerLevel,
    departmentCount: customer.departmentCount,
    lastOrderDate: customer.lastOrderDate,
    wealthTier: canSeeWealth ? wf?.wealthTier : null,
    recentMover: wf?.recentMover,
    recentMortgage: wf?.recentMortgage,
    recentlyDivorced: wf?.recentlyDivorced,
    moneyInMotion: wf?.moneyInMotion,
    liquidityTrigger: wf?.liquidityTrigger,
  });
  const canSeeScore =
    effectiveRole === "ADMIN" ||
    effectiveRole === "SUPER_ADMIN" ||
    effectiveRole === "MANAGER" ||
    effectiveRole === "MARKETING";
  return <LeadScoreBadge tier={score.tier} score={canSeeScore ? score.score : null} />;
}

function LifetimeStats({ customer }: { customer: CustomerWithRelations }) {
  const formatMoney = useMoneyFormatter();
  const spend = Number(customer.lifetimeSpend || 0);
  if (spend === 0 && !customer.lifetimeOrderCount) return null;

  const formatRelative = (iso: string | null | undefined): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const days = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${(days / 365).toFixed(1)}yr ago`;
  };

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-sh-gray mt-1">
      <span>
        Lifetime: <strong className="text-sh-black">{formatMoney(spend, { whole: true })}</strong>
      </span>
      <span>
        Orders: <strong className="text-sh-black">{customer.lifetimeOrderCount ?? 0}</strong>
      </span>
      <span>
        Last order:{" "}
        <strong className="text-sh-black">{formatRelative(customer.lastOrderDate)}</strong>
      </span>
      {customer.customerGroup && (
        <span>
          Primary:{" "}
          <strong className="text-sh-black">
            {GROUP_LABELS[customer.customerGroup] ?? customer.customerGroup}
          </strong>
        </span>
      )}
      {(customer.departmentCount ?? 0) > 1 && (
        <span>
          Shops across: <strong className="text-sh-black">{customer.departmentCount} groups</strong>
        </span>
      )}
    </div>
  );
}

function EmailEngagementSummary({ customerId }: { customerId: number }) {
  const [stats, setStats] = useState<EmailStats | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`/api/customers/${customerId}/email-stats`);
      setStats(data as EmailStats);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  if (loading || !stats || stats.totalSent === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h2 className="text-xl font-semibold mb-3">Email Engagement</h2>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow-md p-4 text-center">
          <p className="text-xs text-sh-gray mb-1">Emails Sent</p>
          <p className="text-2xl font-bold text-sh-black">{stats.totalSent}</p>
        </div>
        <div className="bg-white rounded-lg shadow-md p-4 text-center">
          <p className="text-xs text-sh-gray mb-1">Opens</p>
          <p className="text-2xl font-bold text-sh-black">{stats.totalOpens}</p>
        </div>
        <div className="bg-white rounded-lg shadow-md p-4 text-center">
          <p className="text-xs text-sh-gray mb-1">Open Rate</p>
          <p className="text-2xl font-bold text-sh-black">{stats.openRate}%</p>
        </div>
        <div className="bg-white rounded-lg shadow-md p-4 text-center">
          <p className="text-xs text-sh-gray mb-1">Clicks</p>
          <p className="text-2xl font-bold text-sh-black">{stats.totalClicks}</p>
        </div>
        <div className="bg-white rounded-lg shadow-md p-4 text-center">
          <p className="text-xs text-sh-gray mb-1">Click Rate</p>
          <p className="text-2xl font-bold text-sh-black">{stats.clickRate}%</p>
        </div>
      </div>
    </div>
  );
}

function EmailActivityPanel({ email }: { email: string | null }) {
  const [activities, setActivities] = useState<EmailActivityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadActivity = useCallback(async () => {
    if (!email) return;
    setLoading(true);
    try {
      const res = await axios.get("/api/mailchimp/activities", {
        params: { search: email, limit: 50 },
      });
      const rows = res.data.activity || res.data.activities || [];
      const mapped: EmailActivityRow[] = Array.isArray(rows)
        ? rows.map((a: Record<string, unknown>) => ({
            email: String(a.email ?? ""),
            action: String(a.action ?? ""),
            timestamp: String(a.timestamp ?? ""),
            campaignName:
              (a.campaignName as string | null) ??
              (a.campaign as { name?: string } | undefined)?.name ??
              null,
          }))
        : [];
      setActivities(mapped);
    } catch {
      // Silently handle -- empty state will show "No email activity found"
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [email]);

  useEffect(() => {
    if (!loaded) loadActivity();
  }, [loaded, loadActivity]);

  if (!email) {
    return <p className="text-sh-gray">No email address on file.</p>;
  }

  if (loading) {
    return <p className="text-sh-gray">Loading email activity...</p>;
  }

  if (activities.length === 0) {
    return <p className="text-sh-gray">No email activity found for {email}.</p>;
  }

  return (
    <div className="space-y-2">
      {activities.map((a, i) => (
        <div
          key={`${a.timestamp}-${a.action}-${i}`}
          className="flex items-center gap-3 py-2 border-b border-sh-gray/10 last:border-0"
        >
          <span
            className={`text-xs px-2 py-0.5 rounded min-w-[50px] text-center ${emailActionStyle(a.action)}`}
          >
            {a.action}
          </span>
          <span className="text-sm text-sh-black flex-1">
            {a.campaignName || "Unknown campaign"}
          </span>
          <span className="text-xs text-sh-gray">
            {format(new Date(a.timestamp), "MMM d, yyyy h:mm a")}
          </span>
        </div>
      ))}
    </div>
  );
}

// Signed comparison of two like-typed scalars, scaled by direction (+1 asc /
// -1 desc). Returns 0 when equal.
function compareScalar(a: number | string, b: number | string, dir: number): number {
  if (a < b) return -dir;
  if (a > b) return dir;
  return 0;
}

function compareOrders(
  a: SalesOrderWithCalculatedFields,
  b: SalesOrderWithCalculatedFields,
  sortConfig: SortConfig,
): number {
  const aValue = a[sortConfig.key as keyof SalesOrderWithCalculatedFields];
  const bValue = b[sortConfig.key as keyof SalesOrderWithCalculatedFields];
  const dir = sortConfig.direction === "asc" ? 1 : -1;

  if (aValue === undefined || aValue === null) return 1;
  if (bValue === undefined || bValue === null) return -1;

  if (sortConfig.key === "orderDate") {
    return compareScalar(
      new Date(aValue as string).getTime(),
      new Date(bValue as string).getTime(),
      dir,
    );
  }
  if (typeof aValue === "number" && typeof bValue === "number") {
    return compareScalar(aValue, bValue, dir);
  }
  if (typeof aValue === "string" && typeof bValue === "string") {
    return compareScalar(aValue.toLowerCase(), bValue.toLowerCase(), dir);
  }
  return 0;
}

const ROWS_PER_PAGE = 10;

export function CustomerDetailView({ id }: { id: string }) {
  const { effectiveRole } = useEffectiveRole();
  const canSeeWealth =
    effectiveRole === "ADMIN" || effectiveRole === "SUPER_ADMIN" || effectiveRole === "MARKETING";
  const formatCurrency = useMoneyFormatter();

  const [customer, setCustomer] = useState<CustomerWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isAddAddressModalOpen, setIsAddAddressModalOpen] = useState(false);
  const [newAddress, setNewAddress] = useState<Partial<CustomerAddressRecord>>({});
  const [page, setPage] = useState(1);
  const [sortConfig, setSortConfig] = useState<SortConfig | undefined>(undefined);

  // Trade program state
  const [tradeTiers, setTradeTiers] = useState<TradeTier[]>([]);
  const [tradeEditing, setTradeEditing] = useState(false);
  const [tradeForm, setTradeForm] = useState({
    isTradeAccount: false,
    tradeTierId: "",
    tradeCompanyName: "",
    taxExemptNumber: "",
  });
  const [tradeSaving, setTradeSaving] = useState(false);

  const fetchCustomer = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`/api/customers/${encodeURIComponent(id)}`);
      const orders: SalesOrderRaw[] = data.salesOrders || [];
      const customerWithCalculations: CustomerWithRelations = {
        ...data,
        salesOrders: orders.map((order) => {
          const totalNetPrice = order.lineItems.reduce(
            (sum, item) => sum + Number(item.netPrice || 0),
            0,
          );
          const totalTax = order.lineItems.reduce(
            (sum, item) => sum + Number(item.vatAmount || 0),
            0,
          );
          const calculatedOrderTotal = totalNetPrice + totalTax;
          const calculatedTotalPaid = (order.payments || []).reduce(
            (sum, payment) => sum + Number(payment.paymentAmount || 0),
            0,
          );
          return { ...order, calculatedOrderTotal, calculatedTotalPaid };
        }),
      };
      setCustomer(customerWithCalculations);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load customer details."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchTradeTiers = useCallback(async () => {
    try {
      const { data } = await axios.get("/api/admin/trade-tiers");
      const rows = (data || []) as TradeTier[];
      const active = rows
        .filter((t) => t.isActive)
        .map((t) => ({ ...t, discountPercent: Number(t.discountPercent) }));
      setTradeTiers(active);
    } catch {
      // Non-critical; trade section still renders without tier options
    }
  }, []);

  useEffect(() => {
    fetchCustomer();
  }, [fetchCustomer]);

  useEffect(() => {
    fetchTradeTiers();
  }, [fetchTradeTiers]);

  // Sync trade form when customer data loads
  useEffect(() => {
    if (customer) {
      setTradeForm({
        isTradeAccount: customer.isTradeAccount,
        tradeTierId: customer.tradeTierId ? String(customer.tradeTierId) : "",
        tradeCompanyName: customer.tradeCompanyName || "",
        taxExemptNumber: customer.taxExemptNumber || "",
      });
    }
  }, [customer]);

  const resetTradeForm = useCallback(() => {
    if (!customer) return;
    setTradeForm({
      isTradeAccount: customer.isTradeAccount,
      tradeTierId: customer.tradeTierId ? String(customer.tradeTierId) : "",
      tradeCompanyName: customer.tradeCompanyName || "",
      taxExemptNumber: customer.taxExemptNumber || "",
    });
  }, [customer]);

  const saveTradeSettings = async () => {
    setTradeSaving(true);
    try {
      await axios.put(`/api/customers/${encodeURIComponent(id)}/trade`, {
        isTradeAccount: tradeForm.isTradeAccount,
        tradeTierId: tradeForm.tradeTierId ? Number(tradeForm.tradeTierId) : null,
        tradeCompanyName: tradeForm.tradeCompanyName || null,
        taxExemptNumber: tradeForm.taxExemptNumber || null,
      });
      toast.success("Trade settings updated");
      setTradeEditing(false);
      fetchCustomer();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update trade settings"));
    } finally {
      setTradeSaving(false);
    }
  };

  const handleEditModalClose = () => {
    setIsEditModalOpen(false);
    fetchCustomer();
  };

  const handleAddAddress = async () => {
    if (!newAddress.address1 || !newAddress.city || !newAddress.state || !newAddress.zip) {
      toast.error("Please fill in all required address fields.");
      return;
    }
    try {
      await axios.post(`/api/customers/${encodeURIComponent(id)}/addresses`, newAddress);
      toast.success("Address added successfully!");
      setIsAddAddressModalOpen(false);
      setNewAddress({});
      fetchCustomer();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to add address."));
    }
  };

  const handleDeleteAddress = async (addressId: number) => {
    if (!globalThis.confirm("Are you sure you want to delete this address?")) return;
    try {
      await axios.delete(`/api/customers/${encodeURIComponent(id)}/addresses`, {
        data: { id: addressId },
      });
      toast.success("Address deleted successfully!");
      fetchCustomer();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to delete address."));
    }
  };

  const handleSort = (key: string) => {
    let direction: "asc" | "desc" = "asc";
    if (sortConfig && sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setSortConfig({ key, direction });
  };

  const sortedOrders = useMemo(() => {
    if (!customer?.salesOrders) return [];
    const sortableItems = [...customer.salesOrders];
    if (sortConfig) {
      sortableItems.sort((a, b) => compareOrders(a, b, sortConfig));
    }
    return sortableItems;
  }, [customer?.salesOrders, sortConfig]);

  // Filter out CANCELLED orders from customer-level aggregates. Rewritten base
  // orders and their accounting-return counterparts are cancelled during import
  // (or via the 2026-04-21 backfill migration) so they don't double-count.
  const activeOrders = useMemo(() => {
    if (!customer?.salesOrders) return [];
    return customer.salesOrders.filter((o) => o.status !== "CANCELLED");
  }, [customer?.salesOrders]);

  // For balance / total-value math, also exclude QUOTE orders -- quotes aren't
  // confirmed/paid so they shouldn't show as Balance Due (user report
  // 2026-05-06). CANCELLED is already excluded from activeOrders above.
  const balanceableOrders = useMemo(
    () => activeOrders.filter((o) => o.status !== "QUOTE"),
    [activeOrders],
  );

  const totalOrdersValue = useMemo(
    () => balanceableOrders.reduce((sum, order) => sum + order.calculatedOrderTotal, 0),
    [balanceableOrders],
  );

  const totalPaymentsValue = useMemo(
    () => balanceableOrders.reduce((sum, order) => sum + order.calculatedTotalPaid, 0),
    [balanceableOrders],
  );

  const ordersColumns = useMemo(
    () => [
      {
        key: "orderno",
        label: "Order Number",
        accessor: "orderno",
        width: "150px",
        render: (row: SalesOrderWithCalculatedFields) => (
          <Link href={`/app/sales/orders/${row.id}`} className="text-sh-blue hover:underline">
            {row.orderno}
          </Link>
        ),
        sortable: true,
      },
      {
        key: "orderDate",
        label: "Order Date",
        accessor: "orderDate",
        width: "150px",
        render: (row: SalesOrderWithCalculatedFields) =>
          row.orderDate ? format(parseLocalDate(row.orderDate), "MM/dd/yyyy") : "—",
        sortable: true,
      },
      {
        key: "calculatedOrderTotal",
        label: "Order Total",
        accessor: "calculatedOrderTotal",
        width: "150px",
        align: "right" as const,
        render: (row: SalesOrderWithCalculatedFields) => formatCurrency(row.calculatedOrderTotal),
        sortable: true,
      },
      {
        key: "calculatedTotalPaid",
        label: "Amount Paid",
        accessor: "calculatedTotalPaid",
        width: "150px",
        align: "right" as const,
        render: (row: SalesOrderWithCalculatedFields) => formatCurrency(row.calculatedTotalPaid),
        sortable: true,
      },
    ],
    [formatCurrency],
  );

  if (loading) {
    return <div className="container mx-auto px-4 py-8">Loading...</div>;
  }

  if (!customer) {
    return <div className="container mx-auto px-4 py-8">Customer not found.</div>;
  }

  const paginatedOrders = sortedOrders.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);

  return (
    <div className="container mx-auto px-4 py-8 font-serif">
      <div className="flex justify-between items-start mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">
              {customer.firstName} {customer.lastName}
            </h1>
            <CustomerLevelBadge
              level={customer.customerLevel}
              peak={customer.peakCustomerLevel}
              group={customer.customerGroup}
            />
            <CustomerLeadScore
              customer={customer}
              effectiveRole={effectiveRole}
              canSeeWealth={canSeeWealth}
            />
            {canSeeWealth && <WealthTierBadge tier={customer.windfallEnrichment?.wealthTier} />}
            {customer.isTradeAccount && customer.tradeTier && (
              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-sh-gold/20 text-sh-gold">
                {customer.tradeTier.name}
              </span>
            )}
          </div>
          <LifetimeStats customer={customer} />
        </div>
        <Button onClick={() => setIsEditModalOpen(true)}>Edit Customer</Button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Summary</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <p>
            <strong>Orders:</strong> {customer.salesOrders.length}
          </p>
          <p>
            <strong>Total Value:</strong> {formatCurrency(totalOrdersValue)}
          </p>
          <p>
            <strong>Total Paid:</strong> {formatCurrency(totalPaymentsValue)}
          </p>
          <p>
            <strong>Balance Due:</strong> {formatCurrency(totalOrdersValue - totalPaymentsValue)}
          </p>
        </div>
      </div>

      <EmailEngagementSummary customerId={customer.id} />

      <Tabs defaultValue="contact">
        <TabsList>
          <TabsTrigger value="contact">Contact Info</TabsTrigger>
          <TabsTrigger value="trade">Trade</TabsTrigger>
          <TabsTrigger value="addresses">Addresses</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="email">Email Activity</TabsTrigger>
          {canSeeWealth && <TabsTrigger value="wealth">Wealth Profile</TabsTrigger>}
          <TabsTrigger value="POS">the POS IDs</TabsTrigger>
        </TabsList>

        <TabsContent tabValue="contact">
          <div className="space-y-4">
            <p>
              <strong>Email:</strong> {customer.email || "N/A"}
            </p>
            <p>
              <strong>Phone:</strong> {customer.phone || "N/A"}
            </p>
          </div>
        </TabsContent>

        <TabsContent tabValue="trade">
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Trade Program</h2>
              {!tradeEditing && (
                <Button size="sm" variant="outline" onClick={() => setTradeEditing(true)}>
                  Edit
                </Button>
              )}
            </div>

            {tradeEditing ? (
              <div className="bg-white rounded-lg shadow-md p-6 space-y-4">
                <FormCheckbox
                  label="Trade Account"
                  name="isTradeAccount"
                  checked={tradeForm.isTradeAccount}
                  onChange={(e) =>
                    setTradeForm((prev) => ({ ...prev, isTradeAccount: e.target.checked }))
                  }
                />
                <FormDropdown
                  label="Trade Tier"
                  options={tradeTiers.map((t) => ({
                    id: String(t.id),
                    name: `${t.name} (${Number(t.discountPercent)}% off anchor)`,
                  }))}
                  value={tradeForm.tradeTierId}
                  onChange={(v) => setTradeForm((prev) => ({ ...prev, tradeTierId: v }))}
                />
                <FormInput
                  label="Company Name"
                  name="tradeCompanyName"
                  value={tradeForm.tradeCompanyName}
                  onChange={(v) => setTradeForm((prev) => ({ ...prev, tradeCompanyName: v }))}
                  placeholder="Business name"
                />
                <FormInput
                  label="Tax Exempt Number"
                  name="taxExemptNumber"
                  value={tradeForm.taxExemptNumber}
                  onChange={(v) => setTradeForm((prev) => ({ ...prev, taxExemptNumber: v }))}
                  placeholder="Tax exempt certificate number"
                />
                <div className="flex gap-2 pt-2">
                  <Button onClick={saveTradeSettings} disabled={tradeSaving}>
                    {tradeSaving ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTradeEditing(false);
                      resetTradeForm();
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow-md p-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-sh-gray text-xs mb-1">Status</p>
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        customer.isTradeAccount
                          ? "bg-sh-gold/20 text-sh-gold"
                          : "bg-sh-gray/20 text-sh-gray"
                      }`}
                    >
                      {customer.isTradeAccount ? "Trade Account" : "Retail"}
                    </span>
                  </div>
                  <div>
                    <p className="text-sh-gray text-xs mb-1">Tier</p>
                    <p className="font-medium">
                      {customer.tradeTier
                        ? `${customer.tradeTier.name} (${Number(customer.tradeTier.discountPercent)}% off anchor)`
                        : "None"}
                    </p>
                  </div>
                  <div>
                    <p className="text-sh-gray text-xs mb-1">Company</p>
                    <p className="font-medium">{customer.tradeCompanyName || "Not set"}</p>
                  </div>
                  <div>
                    <p className="text-sh-gray text-xs mb-1">Tax Exempt Number</p>
                    <p className="font-medium">{customer.taxExemptNumber || "Not set"}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent tabValue="addresses">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">Addresses</h2>
            <Button onClick={() => setIsAddAddressModalOpen(true)}>Add Address</Button>
          </div>
          {customer.addresses.length > 0 ? (
            <ul className="space-y-2">
              {customer.addresses.map((address) => (
                <li
                  key={address.id}
                  className="border p-4 rounded-lg flex justify-between items-center"
                >
                  <div>
                    <p>{address.address1}</p>
                    {address.address2 && <p>{address.address2}</p>}
                    <p>
                      {address.city}, {address.state} {address.zip}
                    </p>
                  </div>
                  <Button onClick={() => handleDeleteAddress(address.id)} variant="secondary">
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No addresses found for this customer.</p>
          )}
        </TabsContent>

        <TabsContent tabValue="email">
          <h2 className="text-xl font-semibold mb-4">Email Activity Log</h2>
          <EmailActivityPanel email={customer.email} />
        </TabsContent>

        {canSeeWealth && (
          <TabsContent tabValue="wealth">
            <h2 className="text-xl font-semibold mb-4">Wealth Profile</h2>
            {customer.windfallEnrichment ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="bg-sh-linen rounded-lg p-4">
                    <p className="text-xs text-sh-gray uppercase tracking-wide">Net Worth</p>
                    <p className="text-lg font-semibold text-sh-black mt-1">
                      {customer.windfallEnrichment.netWorth
                        ? `$${(customer.windfallEnrichment.netWorth / 1_000_000).toFixed(1)}M`
                        : "Unknown"}
                    </p>
                    {customer.windfallEnrichment.netWorthLow != null &&
                      customer.windfallEnrichment.netWorthHigh != null && (
                        <p className="text-xs text-sh-gray mt-0.5">
                          Range: ${(customer.windfallEnrichment.netWorthLow / 1_000_000).toFixed(1)}
                          M - ${(customer.windfallEnrichment.netWorthHigh / 1_000_000).toFixed(1)}M
                        </p>
                      )}
                  </div>
                  <div className="bg-sh-linen rounded-lg p-4">
                    <p className="text-xs text-sh-gray uppercase tracking-wide">Tier</p>
                    <p className="mt-1">
                      <WealthTierBadge tier={customer.windfallEnrichment.wealthTier} />
                    </p>
                  </div>
                  <div className="bg-sh-linen rounded-lg p-4">
                    <p className="text-xs text-sh-gray uppercase tracking-wide">Match Confidence</p>
                    <p className="text-lg font-semibold text-sh-black mt-1">
                      {customer.windfallEnrichment.matchConfidence != null
                        ? `${Math.round(Number(customer.windfallEnrichment.matchConfidence) * 100)}%`
                        : "—"}
                    </p>
                  </div>
                  <div className="bg-sh-linen rounded-lg p-4">
                    <p className="text-xs text-sh-gray uppercase tracking-wide">Last Updated</p>
                    <p className="text-sm text-sh-black mt-1">
                      {customer.windfallEnrichment.netWorthLastCalculated
                        ? format(
                            new Date(customer.windfallEnrichment.netWorthLastCalculated),
                            "MMM d, yyyy",
                          )
                        : "—"}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-sh-gray uppercase tracking-wide mb-2">
                    Active Signals
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {customer.windfallEnrichment.recentMover && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                        Recent Mover
                      </span>
                    )}
                    {customer.windfallEnrichment.boatOwner && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        Boat Owner
                      </span>
                    )}
                    {customer.windfallEnrichment.planeOwner && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        Plane Owner
                      </span>
                    )}
                    {customer.windfallEnrichment.multiPropertyOwner && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        Multi-property
                      </span>
                    )}
                    {customer.windfallEnrichment.rentalPropertyOwner && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        Rental Property
                      </span>
                    )}
                    {customer.windfallEnrichment.philanthropicGiver && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        Philanthropic Giver
                      </span>
                    )}
                    {customer.windfallEnrichment.smallBusinessOwner && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                        Small Business
                      </span>
                    )}
                    {customer.windfallEnrichment.politicalDonor && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        Political Donor
                      </span>
                    )}
                    {customer.windfallEnrichment.moneyInMotion && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                        Money in Motion
                      </span>
                    )}
                    {customer.windfallEnrichment.recentlyDivorced && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                        Recently Divorced
                      </span>
                    )}
                    {customer.windfallEnrichment.recentDeathInFamily && (
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                        Death in Family
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-sh-gray">
                  Windfall ID: {customer.windfallEnrichment.windfallId || "—"}
                </p>
              </div>
            ) : (
              <p className="text-sh-gray text-sm">
                No Windfall enrichment data available for this customer.
              </p>
            )}
          </TabsContent>
        )}

        <TabsContent tabValue="POS">
          <h2 className="text-xl font-semibold mb-4">the POS IDs</h2>
          {customer.externalIds.length > 0 ? (
            <ul className="list-disc list-inside">
              {customer.externalIds.map((ext) => (
                <li key={ext.id}>{ext.externalId}</li>
              ))}
            </ul>
          ) : (
            <p>No the POS IDs associated with this customer.</p>
          )}
        </TabsContent>

        <TabsContent tabValue="orders">
          <h2 className="text-xl font-semibold mb-4">Customer Orders</h2>
          {customer.salesOrders && customer.salesOrders.length > 0 ? (
            <PaginatedTable
              data={paginatedOrders}
              columns={ordersColumns}
              totalCount={customer.salesOrders.length}
              onPageChange={setPage}
              currentPage={page}
              loading={loading}
              onSort={handleSort}
              sortConfig={sortConfig}
              rowsPerPage={ROWS_PER_PAGE}
            />
          ) : (
            <p>No orders found for this customer.</p>
          )}
        </TabsContent>
      </Tabs>

      {/* CustomerEditModal only reads id + the contact fields; the JSON-shaped
          detail satisfies that at runtime. Cast through unknown rather than
          import the full Prisma Customer (with its Decimal/Date columns). */}
      {isEditModalOpen && (
        <CustomerEditModal item={customer as unknown as Customer} onClose={handleEditModalClose} />
      )}

      {isAddAddressModalOpen && (
        <Modal
          title="Add New Address"
          onClose={() => setIsAddAddressModalOpen(false)}
          onSave={handleAddAddress}
        >
          <FormInput
            label="Address Line 1"
            name="address1"
            value={newAddress.address1 || ""}
            onChange={(v) => setNewAddress((prev) => ({ ...prev, address1: v }))}
          />
          <FormInput
            label="Address Line 2 (Optional)"
            name="address2"
            value={newAddress.address2 || ""}
            onChange={(v) => setNewAddress((prev) => ({ ...prev, address2: v }))}
          />
          <div className="grid grid-cols-2 gap-4">
            <FormInput
              label="City"
              name="city"
              value={newAddress.city || ""}
              onChange={(v) => setNewAddress((prev) => ({ ...prev, city: v }))}
            />
            <FormInput
              label="State"
              name="state"
              value={newAddress.state || ""}
              onChange={(v) => setNewAddress((prev) => ({ ...prev, state: v }))}
            />
          </div>
          <FormInput
            label="ZIP Code"
            name="zip"
            value={newAddress.zip || ""}
            onChange={(v) => setNewAddress((prev) => ({ ...prev, zip: v }))}
          />
        </Modal>
      )}
    </div>
  );
}
