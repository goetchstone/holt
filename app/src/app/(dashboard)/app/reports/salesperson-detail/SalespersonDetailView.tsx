"use client";

// /app/src/app/(dashboard)/app/reports/salesperson-detail/SalespersonDetailView.tsx
//
// Client view for the salesperson detail report. A viewer who may see every
// salesperson (canSeeAllSalespeople, decided by the server page from "See every
// salesperson's numbers") picks one; everyone else is scoped to their own record
// server-side. Data via tRPC; the server procedure resolves the effective
// salesperson from the session, so the client name is only a hint that viewer
// controls. Month -> customer -> order -> line-item drilldown with bespoke
// expand/collapse state.

import { useState, useEffect } from "react";
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { parseLocalDate } from "@/lib/dateUtils";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

interface LineItemDetail {
  partNo: string;
  productName: string;
  qty: number;
  netPrice: number;
}

interface OrderDetail {
  orderno: string;
  orderDate: string;
  netSales: number;
  isSplit: boolean;
  lineItems: LineItemDetail[];
}

interface CustomerRow {
  customerName: string;
  customerId: number | null;
  orderCount: number;
  netSales: number;
  isSplit: boolean;
  orders: OrderDetail[];
}

interface StaffOption {
  id: number;
  displayName: string;
  role: string;
}

// The tenant-bound currency formatter, threaded to the drilldown subcomponents.
type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;
type ToggleCustomer = (monthKey: string, custKey: string) => void;
type ToggleOrder = (orderno: string) => void;

/**
 * Single line-item drilldown row. Extracted as its own component so the
 * surrounding map → map → map nesting doesn't trigger S2004 (>4 levels
 * deep) on the parent render.
 */
function LineItemRow({
  ord,
  li,
  liIdx,
  money,
}: Readonly<{
  ord: OrderDetail;
  li: LineItemDetail;
  liIdx: number;
  money: MoneyFormatter;
}>) {
  return (
    <tr key={`${ord.orderno}-${liIdx}`} className="border-b border-gray-50 bg-white/80">
      <td className="py-1 pl-16 pr-4 text-xs text-brand-gray" colSpan={2}>
        <span className="text-brand-navy">{li.productName || li.partNo}</span>
        {li.partNo && li.productName && (
          <span className="ml-1.5 text-brand-gray/60">{li.partNo}</span>
        )}
        {li.qty > 1 && <span className="ml-1.5 text-brand-gray/60">x{li.qty}</span>}
      </td>
      <td className="px-4 py-1 text-right text-xs text-brand-gray">
        {money(li.netPrice, { whole: true })}
      </td>
    </tr>
  );
}

/**
 * Single order drilldown row, with conditional line-item children.
 * Extracted from the month/customer/order/line-item render chain to
 * resolve S2004 (function nesting > 4 levels). Inner LineItemRow
 * keeps the deepest level a flat function, not a deeply-nested
 * lambda.
 */
function OrderRow({
  ord,
  isOrdExpanded,
  onToggle,
  money,
}: Readonly<{
  ord: OrderDetail;
  isOrdExpanded: boolean;
  onToggle: () => void;
  money: MoneyFormatter;
}>) {
  return (
    <>
      <tr
        key={ord.orderno}
        onClick={onToggle}
        className="border-b border-gray-50 bg-gray-50/50 cursor-pointer hover:bg-gray-100/50"
      >
        <td className="py-1.5 pl-10 pr-4 text-xs text-brand-gray">
          <span className="flex items-center gap-1">
            {isOrdExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            {ord.orderno}
            {ord.isSplit && <span className="ml-1 text-amber-600">(split)</span>}
          </span>
        </td>
        <td className="px-4 py-1.5 text-center text-xs text-brand-gray">
          {parseLocalDate(ord.orderDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </td>
        <td className="px-4 py-1.5 text-right text-xs text-brand-gray">
          {money(ord.netSales, { whole: true })}
        </td>
      </tr>
      {isOrdExpanded &&
        ord.lineItems.map((li, liIdx) => (
          <LineItemRow
            key={`${ord.orderno}-${liIdx}`}
            ord={ord}
            li={li}
            liIdx={liIdx}
            money={money}
          />
        ))}
    </>
  );
}

/**
 * Single customer row + its expanded order list. Extracted so the
 * outer month / customer map chain doesn't push the inner OrderRow
 * onToggle lambda past 4 levels of nesting (S2004).
 */
function CustomerDrilldownRow({
  cust,
  monthKey,
  rowIndex,
  isCustExpanded,
  expandedOrders,
  onToggleCustomer,
  onToggleOrder,
  money,
}: Readonly<{
  cust: CustomerRow;
  monthKey: string;
  rowIndex: number;
  isCustExpanded: boolean;
  expandedOrders: Set<string>;
  onToggleCustomer: ToggleCustomer;
  onToggleOrder: ToggleOrder;
  money: MoneyFormatter;
}>) {
  const custKey = String(cust.customerId ?? cust.customerName);
  const showDrilldown = cust.orders && cust.orders.length > 0;
  return (
    <>
      <tr
        key={custKey}
        onClick={() => showDrilldown && onToggleCustomer(monthKey, custKey)}
        className={`border-b border-gray-100 ${rowIndex % 2 === 1 ? "bg-brand-stripe" : "bg-white"} ${showDrilldown ? "cursor-pointer hover:bg-gray-50" : ""}`}
      >
        <td className="px-4 py-2 text-sm text-brand-navy">
          <span className="flex items-center gap-1.5">
            {showDrilldown &&
              (isCustExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-brand-gray" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-brand-gray" />
              ))}
            {cust.customerName}
            {cust.isSplit && (
              <span className="ml-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                split
              </span>
            )}
          </span>
        </td>
        <td className="px-4 py-2 text-center text-sm text-brand-gray">{cust.orderCount}</td>
        <td className="px-4 py-2 text-right text-sm text-brand-navy">
          {money(cust.netSales, { whole: true })}
        </td>
      </tr>
      {isCustExpanded &&
        cust.orders
          .toSorted((a, b) => new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime())
          .map((ord) => (
            <OrderRow
              key={ord.orderno}
              ord={ord}
              isOrdExpanded={expandedOrders.has(ord.orderno)}
              onToggle={() => onToggleOrder(ord.orderno)}
              money={money}
            />
          ))}
    </>
  );
}

export function SalespersonDetailView({
  canSeeAllSalespeople,
}: Readonly<{ canSeeAllSalespeople: boolean }>) {
  const money = useMoneyFormatter();

  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [expandedCustomers, setExpandedCustomers] = useState<Set<string>>(new Set());
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (canSeeAllSalespeople) {
      fetch("/api/staff")
        .then((r) => r.json())
        .then((d) => {
          const salesRoles = new Set(["DESIGNER", "MANAGER"]);
          const list = (d.staff || d || [])
            .filter((s: StaffOption) => salesRoles.has(s.role))
            .map((s: StaffOption) => ({
              id: s.id,
              displayName: s.displayName,
              role: s.role,
            }));
          setStaff(list);
        })
        .catch(() => {});
    } else {
      fetch("/api/staff/me")
        .then((r) => r.json())
        .then((d) => {
          if (d.displayName) setSelectedName(d.displayName);
        })
        .catch(() => {});
    }
  }, [canSeeAllSalespeople]);

  // A viewer who may see everyone picks a name first; anyone else is resolved
  // server-side (the page that rendered this view has already signed them in).
  const enabled = canSeeAllSalespeople ? !!selectedName : true;
  const query = api.reports.salespersonDetail.useQuery(
    { salesperson: selectedName, year },
    { enabled },
  );
  const loading = query.isFetching;
  const data = query.data;

  // Switching salesperson or year shows a different report, so collapse any
  // open drilldowns. Done in the event handlers (not an effect) per React's
  // set-state-in-effect guidance.
  const resetDrilldowns = () => {
    setExpandedMonths(new Set());
    setExpandedCustomers(new Set());
    setExpandedOrders(new Set());
  };

  const toggleMonth = (monthKey: string) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(monthKey)) {
        next.delete(monthKey);
      } else {
        next.add(monthKey);
      }
      return next;
    });
  };

  const toggleCustomer = (monthKey: string, custKey: string) => {
    const compositeKey = `${monthKey}::${custKey}`;
    setExpandedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(compositeKey)) {
        next.delete(compositeKey);
      } else {
        next.add(compositeKey);
      }
      return next;
    });
  };

  const toggleOrder = (orderno: string) => {
    setExpandedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderno)) next.delete(orderno);
      else next.add(orderno);
      return next;
    });
  };

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        {canSeeAllSalespeople && (
          <div>
            <label
              htmlFor="salesperson-detail-name"
              className="block text-xs font-medium text-brand-gray mb-1"
            >
              Salesperson
            </label>
            <select
              id="salesperson-detail-name"
              value={selectedName}
              onChange={(e) => {
                setSelectedName(e.target.value);
                resetDrilldowns();
              }}
              className="rounded border border-gray-300 px-3 min-h-[44px] text-sm focus:border-brand-gold focus:outline-none focus:ring-1 focus:ring-brand-gold"
            >
              <option value="">Select...</option>
              {staff.map((s) => (
                <option key={s.id} value={s.displayName}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label
            htmlFor="salesperson-detail-year"
            className="block text-xs font-medium text-brand-gray mb-1"
          >
            Year
          </label>
          <select
            id="salesperson-detail-year"
            value={year}
            onChange={(e) => {
              setYear(Number(e.target.value));
              resetDrilldowns();
            }}
            className="rounded border border-gray-300 px-3 min-h-[44px] text-sm focus:border-brand-gold focus:outline-none focus:ring-1 focus:ring-brand-gold"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
        </div>
      )}

      {!loading && canSeeAllSalespeople && !selectedName && (
        <p className="py-8 text-center text-sm text-brand-gray">Select a salesperson.</p>
      )}

      {!loading && enabled && !data && (
        <p className="py-8 text-center text-sm text-brand-gray">No data found.</p>
      )}

      {data && !loading && (
        <>
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-brand-navy">
              {data.salesperson} &mdash; {data.year} Sales by Customer
            </h2>
            <div className="text-right">
              <p className="text-sm text-brand-gray">
                YTD Total:{" "}
                <span className="font-semibold text-brand-navy">
                  {money(data.ytdTotal, { whole: true })}
                </span>
              </p>
              <p className="text-xs text-brand-gray">
                {data.ytdOrders} order{data.ytdOrders === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {data.months.map((month) => {
              const isExpanded = expandedMonths.has(month.month);
              return (
                <div
                  key={month.month}
                  className="rounded-lg border border-gray-200 overflow-hidden"
                >
                  <button
                    onClick={() => toggleMonth(month.month)}
                    className="flex w-full items-center justify-between bg-brand-linen px-4 py-3 text-left min-h-[44px]"
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-brand-gray" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-brand-gray" />
                      )}
                      <span className="font-semibold text-brand-navy">{month.label}</span>
                      <span className="text-sm text-brand-gray">
                        ({month.orderCount} order{month.orderCount === 1 ? "" : "s"})
                      </span>
                    </div>
                    <span className="font-semibold text-brand-navy">
                      {money(month.totalSales, { whole: true })}
                    </span>
                  </button>

                  {isExpanded && (
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-200 bg-white">
                          <th className="px-4 py-2 text-left text-xs font-medium text-brand-gray">
                            Customer
                          </th>
                          <th className="px-4 py-2 text-center text-xs font-medium text-brand-gray">
                            Orders
                          </th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-brand-gray">
                            Net Sales
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {month.customers.map((cust, i) => {
                          const custKey = String(cust.customerId ?? cust.customerName);
                          return (
                            <CustomerDrilldownRow
                              key={custKey}
                              cust={cust}
                              monthKey={month.month}
                              rowIndex={i}
                              isCustExpanded={expandedCustomers.has(`${month.month}::${custKey}`)}
                              expandedOrders={expandedOrders}
                              onToggleCustomer={toggleCustomer}
                              onToggleOrder={toggleOrder}
                              money={money}
                            />
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>

          {data.months.length === 0 && (
            <p className="py-8 text-center text-sm text-brand-gray">
              No sales found for {data.year}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
