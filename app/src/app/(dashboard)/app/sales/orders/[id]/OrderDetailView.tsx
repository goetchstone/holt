"use client";

// /app/src/app/(dashboard)/app/sales/orders/[id]/OrderDetailView.tsx
//
// Sales order detail. App Router port of the legacy sales/orders/[id] body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Reads +
// writes the shared /api/sales/orders/:id REST endpoints (status, line-items,
// salesperson, changelog), plus /api/stripe/send-payment-link and
// /api/portal/generate-link, which all stay REST. The id arrives as a prop from
// the server page (params awaited there).

import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";
import Link from "next/link";
import { format } from "date-fns";
import { parseLocalDate } from "@/lib/dateUtils";
import { Button } from "@/components/ui/button";
import { Printer, FileText, Plus, X, RefreshCw, Clock, UserCog, Search } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface LineItem {
  id: number;
  lineNumber?: number;
  productName?: string;
  partNo?: string;
  barcode?: string;
  orderedQuantity: number;
  netPrice: number;
  vatRate?: number;
  vatAmount?: number;
  cost?: number;
  source?: string;
  fulfillment?: string;
  lineItemStatus: string;
  cancelReason?: string;
  replacedByLineItemId?: number;
  selectedGrade?: string;
  productId?: number;
}

interface ChangeLogEntry {
  id: number;
  changeType: string;
  lineItemId?: number;
  previousValue?: string;
  newValue?: string;
  reason?: string;
  changedBy?: string;
  created: string;
}

interface StaffRef {
  id: number;
  displayName: string;
}

interface InvoiceLine {
  id: number;
  deliveredQuantity: number;
  orderLineItem: { partNo?: string };
}

interface OrderInvoice {
  id: number;
  invoiceNo: string;
  invoiceDate: string;
  taxAmount: number;
  lineItems: InvoiceLine[];
}

interface OrderPayment {
  id: number;
  paymentDate: string;
  paymentType: string;
  paymentAmount: number;
}

interface OrderCustomerRef {
  id: number;
  firstName?: string;
  lastName?: string;
}

interface OrderDetails {
  id: number;
  orderno: string;
  orderDate: string;
  status: string;
  salesperson: string;
  salesPersonId: number | null;
  salesPerson: StaffRef | null;
  splitWithId: number | null;
  splitWith: StaffRef | null;
  storeLocation: string;
  deliveryMethod: string | null;
  totalTax: number;
  totalPaid: number;
  orderNotes?: string;
  customer?: OrderCustomerRef | null;
  lineItems: LineItem[];
  invoices: OrderInvoice[];
  payments: OrderPayment[];
}

interface CustomerSearchResult {
  id: number;
  firstName: string;
  lastName: string;
}

interface SalespersonUpdateResponse {
  salesPersonId: number | null;
  salesPerson: StaffRef | null;
  splitWithId: number | null;
  splitWith: StaffRef | null;
  salesperson: string;
}

interface PaymentLinkResponse {
  url: string;
  amount: number;
  isDeposit: boolean;
}

type DepositMode = "full" | "50" | "custom";

const STATUS_LABELS: Record<string, string> = {
  QUOTE: "Quote",
  ORDER: "Order",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  QUOTE: "bg-amber-100 text-amber-800",
  ORDER: "bg-blue-100 text-blue-800",
  FULFILLED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const LINE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
  BACKORDERED: "Backordered",
  REPLACED: "Replaced",
};

const LINE_STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  BACKORDERED: "bg-amber-100 text-amber-800",
  REPLACED: "bg-purple-100 text-purple-800",
};

const DELIVERY_METHOD_LABELS: Record<string, string> = {
  TAKEN: "Taken",
  PICKUP: "Pickup",
  DELIVERY: "Delivery",
};

const CHANGE_TYPE_LABELS: Record<string, string> = {
  STATUS_CHANGE: "Status Changed",
  LINE_ADDED: "Line Added",
  LINE_CANCELLED: "Line Cancelled",
  LINE_REPLACED: "Line Replaced",
  LINE_REMOVED: "Line Removed",
  PRICE_CHANGE: "Price/Qty Changed",
  NOTE_ADDED: "Note Added",
  SALESPERSON_CHANGE: "Salesperson Changed",
};

const DEPOSIT_MODE_LABELS: Record<DepositMode, string> = {
  full: "Full Balance",
  "50": "50% Deposit",
  custom: "Custom",
};

function CustomerField({
  customer,
  orderId,
  onLinked,
}: {
  customer?: OrderCustomerRef | null;
  orderId: number;
  onLinked: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerSearchResult[]>([]);

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }
    try {
      const res = await axios.get(`/api/customers?search=${encodeURIComponent(q)}&limit=8`);
      setResults(res.data.customers || res.data || []);
    } catch {
      setResults([]);
    }
  }, []);

  const linkCustomer = async (custId: number) => {
    try {
      await axios.put(`/api/sales/orders/${orderId}`, { customerId: custId });
      toast.success("Customer linked");
      setSearching(false);
      setQuery("");
      onLinked();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to link customer"));
    }
  };

  if (customer) {
    return (
      <p>
        <strong>Customer:</strong>{" "}
        <Link href={`/app/sales/customers/${customer.id}`} className="text-sh-gold underline">
          {customer.firstName} {customer.lastName}
        </Link>
      </p>
    );
  }

  if (!searching) {
    return (
      <p className="flex items-center gap-2">
        <strong>Customer:</strong>{" "}
        <button
          onClick={() => setSearching(true)}
          className="inline-flex items-center gap-1 rounded border border-sh-gold px-2 py-1 text-xs text-sh-gold hover:bg-sh-gold/10"
        >
          <Search className="h-3 w-3" /> Add Customer
        </button>
      </p>
    );
  }

  return (
    <div>
      <strong>Customer:</strong>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            doSearch(e.target.value);
          }}
          placeholder="Search by name..."
          className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-sh-gold focus:outline-none"
          aria-label="Search customers by name"
        />
        <button onClick={() => setSearching(false)} className="text-sh-gray hover:text-sh-black">
          <X className="h-4 w-4" />
        </button>
      </div>
      {results.length > 0 && (
        <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 bg-white text-sm">
          {results.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => linkCustomer(c.id)}
                className="w-full px-3 py-2 text-left hover:bg-sh-stripe"
              >
                {c.firstName} {c.lastName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const { data: session } = useSession();
  const userRole = (session as { role?: string } | null)?.role || "DESIGNER";
  const isManager = userRole === "MANAGER" || userRole === "ADMIN" || userRole === "SUPER_ADMIN";
  const money = useMoneyFormatter();

  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [paymentLinkLoading, setPaymentLinkLoading] = useState(false);
  const [paymentLinkUrl, setPaymentLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [depositMode, setDepositMode] = useState<DepositMode>("full");
  const [customAmount, setCustomAmount] = useState("");
  const [portalLinkLoading, setPortalLinkLoading] = useState(false);
  const [portalLinkUrl, setPortalLinkUrl] = useState<string | null>(null);
  const [portalLinkCopied, setPortalLinkCopied] = useState(false);

  // Line item management state
  const [cancelModalItem, setCancelModalItem] = useState<LineItem | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [replaceModalItem, setReplaceModalItem] = useState<LineItem | null>(null);
  const [replacementName, setReplacementName] = useState("");
  const [replacementPartNo, setReplacementPartNo] = useState("");
  const [replacementGrade, setReplacementGrade] = useState("");
  const [replaceReason, setReplaceReason] = useState("");
  const [changeLog, setChangeLog] = useState<ChangeLogEntry[]>([]);
  const [showChangeLog, setShowChangeLog] = useState(false);

  // Salesperson management state
  const [showSalespersonModal, setShowSalespersonModal] = useState(false);
  const [staffList, setStaffList] = useState<StaffRef[]>([]);
  const [editSalesPersonId, setEditSalesPersonId] = useState<number | null>(null);
  const [editSplitWithId, setEditSplitWithId] = useState<number | null>(null);
  const [salespersonSaving, setSalespersonSaving] = useState(false);

  const fetchOrder = useCallback(() => {
    if (!id) return;
    setLoading(true);
    axios
      .get(`/api/sales/orders/${encodeURIComponent(String(id))}`)
      .then((res) => setOrderDetails(res.data as OrderDetails))
      .catch(() => toast.error("Failed to load order details."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  const fetchChangeLog = useCallback(async () => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/sales/orders/${encodeURIComponent(String(id))}/changelog`);
      setChangeLog(res.data as ChangeLogEntry[]);
    } catch {
      toast.error("Failed to load change history.");
    }
  }, [id]);

  const openSalespersonModal = useCallback(async () => {
    if (!orderDetails) return;
    setEditSalesPersonId(orderDetails.salesPersonId);
    setEditSplitWithId(orderDetails.splitWithId);
    try {
      const res = await axios.get("/api/staff");
      const rows = res.data as { id: number; displayName: string; isActive: boolean }[];
      setStaffList(
        rows.filter((s) => s.isActive).map((s) => ({ id: s.id, displayName: s.displayName })),
      );
    } catch {
      toast.error("Failed to load staff list.");
    }
    setShowSalespersonModal(true);
  }, [orderDetails]);

  const handleSaveSalesperson = useCallback(async () => {
    if (!orderDetails) return;
    setSalespersonSaving(true);
    try {
      const res = await axios.put(
        `/api/sales/orders/${encodeURIComponent(String(id))}/salesperson`,
        {
          salesPersonId: editSalesPersonId,
          splitWithId: editSplitWithId,
        },
      );
      const data = res.data as SalespersonUpdateResponse;
      setOrderDetails({
        ...orderDetails,
        salesPersonId: data.salesPersonId,
        salesPerson: data.salesPerson,
        splitWithId: data.splitWithId,
        splitWith: data.splitWith,
        salesperson: data.salesperson,
      });
      setShowSalespersonModal(false);
      toast.success("Salesperson updated");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update salesperson"));
    } finally {
      setSalespersonSaving(false);
    }
  }, [orderDetails, id, editSalesPersonId, editSplitWithId]);

  const formatCurrency = useCallback(
    (value: number | null | undefined): string => {
      const num = Number(value);
      if (!Number.isFinite(num)) return "--";
      return money(num);
    },
    [money],
  );

  const handleStatusChange = async (newStatus: string) => {
    if (!orderDetails || statusUpdating) return;
    setStatusUpdating(true);
    try {
      await axios.put(`/api/sales/orders/${encodeURIComponent(String(id))}`, { status: newStatus });
      setOrderDetails({ ...orderDetails, status: newStatus });
      toast.success(`Status updated to ${STATUS_LABELS[newStatus]}`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update status"));
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleDeleteOrder = async () => {
    if (!orderDetails) return;
    const confirmed = confirm(
      `Delete order ${orderDetails.orderno}? This will remove all line items, payments, and invoices. This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await axios.delete(`/api/sales/orders/${encodeURIComponent(String(id))}`);
      toast.success(`Order ${orderDetails.orderno} deleted`);
      router.push("/app/sales/orders");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to delete order"));
    }
  };

  const handleCancelLineItem = async () => {
    if (!cancelModalItem || !cancelReason.trim()) {
      toast.error("Please provide a reason for cancellation.");
      return;
    }
    try {
      await axios.put(
        `/api/sales/orders/${encodeURIComponent(String(id))}/line-items/${encodeURIComponent(String(cancelModalItem.id))}`,
        {
          action: "cancel",
          reason: cancelReason,
        },
      );
      toast.success(`${cancelModalItem.productName} cancelled.`);
      setCancelModalItem(null);
      setCancelReason("");
      fetchOrder();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to cancel line item"));
    }
  };

  const handleReplaceLineItem = async () => {
    if (!replaceModalItem || !replacementName.trim()) {
      toast.error("Replacement product name is required.");
      return;
    }
    try {
      await axios.put(
        `/api/sales/orders/${encodeURIComponent(String(id))}/line-items/${encodeURIComponent(String(replaceModalItem.id))}`,
        {
          action: "replace",
          reason: replaceReason || "Item replaced",
          replacement: {
            productName: replacementName,
            partNo: replacementPartNo || undefined,
            selectedGrade: replacementGrade || undefined,
          },
        },
      );
      toast.success(`${replaceModalItem.productName} replaced with ${replacementName}.`);
      setReplaceModalItem(null);
      setReplacementName("");
      setReplacementPartNo("");
      setReplacementGrade("");
      setReplaceReason("");
      fetchOrder();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to replace line item"));
    }
  };

  const handleRemoveLineItem = async (item: LineItem) => {
    if (!confirm(`Remove ${item.productName} from this quote?`)) return;
    try {
      await axios.delete(
        `/api/sales/orders/${encodeURIComponent(String(id))}/line-items/${encodeURIComponent(String(item.id))}`,
      );
      toast.success(`${item.productName} removed.`);
      fetchOrder();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to remove line item"));
    }
  };

  const getPaymentAmount = useCallback((): number | undefined => {
    if (!orderDetails) return undefined;
    const activeItems = orderDetails.lineItems.filter((i) => i.lineItemStatus === "ACTIVE");
    const totalSales = activeItems.reduce((acc, item) => acc + (Number(item.netPrice) || 0), 0);
    const totalTax = activeItems.reduce((acc, item) => acc + (Number(item.vatAmount) || 0), 0);
    const totalPaid = orderDetails.payments.reduce(
      (acc, p) => acc + (Number(p.paymentAmount) || 0),
      0,
    );
    const balanceDue = totalSales + totalTax - totalPaid;

    if (depositMode === "50") return Math.ceil(balanceDue * 0.5);
    if (depositMode === "custom") return Number.parseFloat(customAmount) || 0;
    return undefined;
  }, [orderDetails, depositMode, customAmount]);

  const handleSendPaymentLink = useCallback(async () => {
    if (!orderDetails) return;
    setPaymentLinkLoading(true);
    setPaymentLinkUrl(null);
    try {
      const amount = getPaymentAmount();
      const res = await axios.post("/api/stripe/send-payment-link", {
        orderId: orderDetails.id,
        amount,
      });
      const data = res.data as PaymentLinkResponse;
      const label = data.isDeposit
        ? `Deposit link created for ${formatCurrency(data.amount)}`
        : "Payment link created";
      setPaymentLinkUrl(data.url);
      toast.success(label);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create payment link"));
    } finally {
      setPaymentLinkLoading(false);
    }
  }, [orderDetails, getPaymentAmount, formatCurrency]);

  const handleCopyLink = useCallback(async () => {
    if (!paymentLinkUrl) return;
    try {
      await navigator.clipboard.writeText(paymentLinkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  }, [paymentLinkUrl]);

  const handleGeneratePortalLink = useCallback(async () => {
    if (!orderDetails) return;
    setPortalLinkLoading(true);
    try {
      const res = await axios.post("/api/portal/generate-link", {
        orderId: orderDetails.id,
      });
      setPortalLinkUrl((res.data as { url: string }).url);
      toast.success("Portal link generated");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to generate portal link"));
    } finally {
      setPortalLinkLoading(false);
    }
  }, [orderDetails]);

  const handleCopyPortalLink = useCallback(async () => {
    if (!portalLinkUrl) return;
    try {
      await navigator.clipboard.writeText(portalLinkUrl);
      setPortalLinkCopied(true);
      setTimeout(() => setPortalLinkCopied(false), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  }, [portalLinkUrl]);

  const handleConveyanceChange = async (newMethod: string) => {
    if (!orderDetails) return;
    try {
      await axios.put(`/api/sales/orders/${encodeURIComponent(String(id))}`, {
        deliveryMethod: newMethod,
      });
      setOrderDetails({ ...orderDetails, deliveryMethod: newMethod });
      toast.success(`Conveyance updated to ${DELIVERY_METHOD_LABELS[newMethod] || newMethod}`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update conveyance"));
    }
  };

  if (loading) {
    return <p>Loading order details...</p>;
  }

  if (!orderDetails) {
    return <p>Order not found.</p>;
  }

  const activeItems = orderDetails.lineItems.filter((i) => i.lineItemStatus === "ACTIVE");
  const totalSales = activeItems.reduce((acc, item) => acc + (Number(item.netPrice) || 0), 0);
  const totalPaid = orderDetails.payments.reduce(
    (acc, p) => acc + (Number(p.paymentAmount) || 0),
    0,
  );
  const totalTax = activeItems.reduce((acc, item) => acc + (Number(item.vatAmount) || 0), 0);
  const balanceDue = totalSales + totalTax - totalPaid;
  const isQuote = orderDetails.status === "QUOTE";
  const isEditable = orderDetails.status === "QUOTE" || orderDetails.status === "ORDER";

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-start mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-sh-blue">{orderDetails.orderno}</h1>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[orderDetails.status] || "bg-gray-100 text-gray-800"}`}
            >
              {STATUS_LABELS[orderDetails.status] || orderDetails.status}
            </span>
          </div>
          <p className="text-sm text-sh-gray">
            {format(parseLocalDate(orderDetails.orderDate), "PPP")}
          </p>
          <div className="flex gap-1.5 mt-2">
            {["QUOTE", "ORDER", "FULFILLED", "CANCELLED"].map((s) => (
              <button
                key={s}
                disabled={orderDetails.status === s || statusUpdating}
                onClick={() => handleStatusChange(s)}
                className={`px-2.5 py-1 text-xs rounded border transition ${
                  orderDetails.status === s
                    ? "bg-sh-blue text-white border-sh-blue cursor-default"
                    : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-blue disabled:opacity-40"
                }`}
              >
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              globalThis.open(`/print/receipt/${id}`, "_blank", "width=350,height=600")
            }
          >
            <Printer className="w-3.5 h-3.5 mr-1" />
            Receipt
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              globalThis.open(`/print/invoice/${id}`, "_blank", "width=800,height=1100")
            }
          >
            <FileText className="w-3.5 h-3.5 mr-1" />
            Invoice
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowChangeLog(!showChangeLog);
              if (!showChangeLog) fetchChangeLog();
            }}
          >
            <Clock className="w-3.5 h-3.5 mr-1" />
            History
          </Button>
          <Button variant="secondary" size="sm" onClick={handleDeleteOrder}>
            Delete
          </Button>
          <Link href="/app/sales/orders">
            <Button variant="outline" size="sm">
              Back
            </Button>
          </Link>
        </div>
      </div>

      {/* Change Log Panel */}
      {showChangeLog && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Change History</h2>
          {changeLog.length === 0 ? (
            <p className="text-sm text-sh-gray">No changes recorded yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {changeLog.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 text-sm border-b border-sh-gray/10 pb-2"
                >
                  <div className="text-xs text-sh-gray whitespace-nowrap pt-0.5">
                    {format(new Date(entry.created), "MMM d, h:mm a")}
                  </div>
                  <div className="flex-1">
                    <span className="font-medium">
                      {CHANGE_TYPE_LABELS[entry.changeType] || entry.changeType}
                    </span>
                    {entry.previousValue && entry.newValue && (
                      <span className="text-sh-gray">
                        {" "}
                        {entry.previousValue} &rarr; {entry.newValue}
                      </span>
                    )}
                    {!entry.previousValue && entry.newValue && (
                      <span className="text-sh-gray"> {entry.newValue}</span>
                    )}
                    {entry.previousValue && !entry.newValue && (
                      <span className="text-sh-gray"> {entry.previousValue}</span>
                    )}
                    {entry.reason && <span className="text-sh-gray italic"> — {entry.reason}</span>}
                  </div>
                  <div className="text-xs text-sh-gray whitespace-nowrap">
                    {entry.changedBy?.split("@")[0]}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Order Summary */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Summary</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <CustomerField
              customer={orderDetails.customer}
              orderId={orderDetails.id}
              onLinked={fetchOrder}
            />
            <div className="flex items-center gap-2">
              <p>
                <strong>Salesperson:</strong>{" "}
                {orderDetails.salesPerson?.displayName || orderDetails.salesperson || "N/A"}
                {orderDetails.splitWith && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                    50/50 with {orderDetails.splitWith.displayName}
                  </span>
                )}
              </p>
              {isManager && (
                <button
                  onClick={openSalespersonModal}
                  className="p-1 text-sh-gray hover:text-sh-blue transition"
                  title="Change salesperson"
                >
                  <UserCog className="w-4 h-4" />
                </button>
              )}
            </div>
            <p>
              <strong>Store:</strong> {orderDetails.storeLocation}
            </p>
            <div className="flex items-center gap-2">
              <strong>Conveyance:</strong>
              {isEditable ? (
                <select
                  aria-label="Conveyance method"
                  value={orderDetails.deliveryMethod || ""}
                  onChange={(e) => handleConveyanceChange(e.target.value)}
                  className="border border-sh-gray/30 rounded px-2 py-1 text-sm"
                >
                  <option value="">Not set</option>
                  {Object.entries(DELIVERY_METHOD_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <span>
                  {orderDetails.deliveryMethod
                    ? DELIVERY_METHOD_LABELS[orderDetails.deliveryMethod] ||
                      orderDetails.deliveryMethod
                    : "Not set"}
                </span>
              )}
            </div>
            {orderDetails.orderNotes && (
              <p>
                <strong>Notes:</strong> {orderDetails.orderNotes}
              </p>
            )}
          </div>
          <div>
            <p>
              <strong>Total Sales:</strong> {formatCurrency(totalSales)}
            </p>
            <p>
              <strong>Total Tax:</strong> {formatCurrency(totalTax)}
            </p>
            <p>
              <strong>Total Paid:</strong> {formatCurrency(totalPaid)}
            </p>
            <p>
              <strong>Balance Due:</strong> {formatCurrency(balanceDue)}
            </p>
            {isManager && balanceDue > 0 && (
              <div className="mt-4 border-t border-sh-gray/20 pt-3">
                <p className="text-xs text-sh-gray mb-2">Payment Request</p>
                <div className="flex items-center gap-2 mb-2">
                  {(["full", "50", "custom"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setDepositMode(mode)}
                      className={`px-2.5 py-1 text-xs rounded border transition ${
                        depositMode === mode
                          ? "bg-sh-blue text-white border-sh-blue"
                          : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-blue"
                      }`}
                    >
                      {DEPOSIT_MODE_LABELS[mode]}
                    </button>
                  ))}
                  {depositMode === "custom" && (
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      placeholder="Amount"
                      aria-label="Custom payment amount"
                      className="w-24 text-xs border border-sh-gray/30 rounded px-2 py-1"
                    />
                  )}
                  {depositMode === "50" && (
                    <span className="text-xs text-sh-gray">
                      {formatCurrency(Math.ceil(balanceDue * 0.5))}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleSendPaymentLink} disabled={paymentLinkLoading}>
                    {paymentLinkLoading ? "Creating..." : "Create Payment Link"}
                  </Button>
                  {paymentLinkUrl && (
                    <>
                      <input
                        type="text"
                        readOnly
                        value={paymentLinkUrl}
                        aria-label="Payment link"
                        className="flex-1 text-xs border border-sh-gray/30 rounded px-2 py-1 bg-sh-linen truncate"
                      />
                      <Button size="sm" variant="outline" onClick={handleCopyLink}>
                        {copied ? "Copied!" : "Copy"}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Customer Portal Link — managers only (test mode) */}
      {isManager && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Customer Portal (Test Mode)</h2>
          <p className="text-xs text-sh-gray mb-3">
            Generate a shareable link for the customer to view their order and make payments. Links
            expire after 7 days.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleGeneratePortalLink} disabled={portalLinkLoading}>
              {portalLinkLoading ? "Generating..." : "Generate Portal Link"}
            </Button>
            {portalLinkUrl && (
              <>
                <input
                  type="text"
                  readOnly
                  value={portalLinkUrl}
                  aria-label="Customer portal link"
                  className="flex-1 text-xs border border-sh-gray/30 rounded px-2 py-1 bg-sh-linen truncate"
                />
                <Button size="sm" variant="outline" onClick={handleCopyPortalLink}>
                  {portalLinkCopied ? "Copied!" : "Copy"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Line Items */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-xl font-semibold">Line Items</h2>
          {isEditable && (
            <Link href={`/app/sales/quotes/new?editOrderId=${orderDetails.id}`}>
              <Button size="sm" variant="outline">
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Item
              </Button>
            </Link>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-2 border-b">Item</th>
                <th className="p-2 border-b text-right whitespace-nowrap">Qty</th>
                <th className="p-2 border-b text-right whitespace-nowrap">Net Price</th>
                <th className="p-2 border-b text-right whitespace-nowrap">Tax</th>
                <th className="p-2 border-b text-center whitespace-nowrap">Status</th>
                {isEditable && <th className="p-2 border-b whitespace-nowrap">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {orderDetails.lineItems.map((item) => {
                const isInactive =
                  item.lineItemStatus === "CANCELLED" || item.lineItemStatus === "REPLACED";
                const replacedByLineNumber = item.replacedByLineItemId
                  ? orderDetails.lineItems.find((l) => l.id === item.replacedByLineItemId)
                      ?.lineNumber
                  : undefined;
                return (
                  <tr
                    key={item.id}
                    className={`${isInactive ? "opacity-50" : ""} odd:bg-white even:bg-sh-stripe`}
                  >
                    <td className="p-2 border-b">
                      <div className="min-w-0">
                        <span className={`font-medium ${isInactive ? "line-through" : ""}`}>
                          {item.partNo || item.productName}
                        </span>
                        {item.partNo && item.productName && (
                          <p className="text-xs text-sh-gray" title={item.productName}>
                            {item.productName}
                          </p>
                        )}
                        {item.selectedGrade && (
                          <span className="text-xs text-sh-gray ml-1">({item.selectedGrade})</span>
                        )}
                        {item.cancelReason && (
                          <p className="text-xs text-red-600 mt-0.5">{item.cancelReason}</p>
                        )}
                        {item.replacedByLineItemId && (
                          <p className="text-xs text-purple-600 mt-0.5">
                            Replaced by line #{replacedByLineNumber || "?"}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="p-2 border-b text-right">{item.orderedQuantity}</td>
                    <td className="p-2 border-b text-right">
                      {isInactive ? (
                        <span className="line-through">{formatCurrency(item.netPrice)}</span>
                      ) : (
                        formatCurrency(item.netPrice)
                      )}
                    </td>
                    <td className="p-2 border-b text-right">
                      {item.vatAmount ? formatCurrency(item.vatAmount) : "—"}
                    </td>
                    <td className="p-2 border-b text-center">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${LINE_STATUS_COLORS[item.lineItemStatus] || "bg-gray-100 text-gray-800"}`}
                      >
                        {LINE_STATUS_LABELS[item.lineItemStatus] || item.lineItemStatus}
                      </span>
                    </td>
                    {isEditable && (
                      <td className="p-2 border-b">
                        {item.lineItemStatus === "ACTIVE" && (
                          <div className="flex gap-1">
                            {isQuote && (
                              <button
                                onClick={() => handleRemoveLineItem(item)}
                                className="p-1 text-sh-gray hover:text-red-600 transition"
                                title="Remove from quote"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setCancelModalItem(item);
                                setCancelReason("");
                              }}
                              className="p-1 text-sh-gray hover:text-red-600 transition"
                              title="Cancel item"
                            >
                              <X className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => {
                                setReplaceModalItem(item);
                                setReplacementName("");
                                setReplacementPartNo(item.partNo || "");
                                setReplacementGrade(item.selectedGrade || "");
                                setReplaceReason("");
                              }}
                              className="p-1 text-sh-gray hover:text-blue-600 transition"
                              title="Replace item"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-sh-linen">
                <td className="p-2" colSpan={2}>
                  Totals (active items)
                </td>
                <td className="p-2 text-right">{formatCurrency(totalSales)}</td>
                <td className="p-2 text-right">{formatCurrency(totalTax)}</td>
                <td className="p-2" colSpan={isEditable ? 2 : 1} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Invoices */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Invoices</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-2 border-b">Invoice No</th>
                <th className="p-2 border-b">Date</th>
                <th className="p-2 border-b text-right">Tax</th>
                <th className="p-2 border-b">Delivered Items</th>
              </tr>
            </thead>
            <tbody>
              {orderDetails.invoices.map((invoice) => (
                <tr key={invoice.id} className="odd:bg-white even:bg-sh-stripe">
                  <td className="p-2 border-b">{invoice.invoiceNo}</td>
                  <td className="p-2 border-b">
                    {format(parseLocalDate(invoice.invoiceDate), "PPP")}
                  </td>
                  <td className="p-2 border-b text-right">{formatCurrency(invoice.taxAmount)}</td>
                  <td className="p-2 border-b">
                    {invoice.lineItems
                      .map((li) => `${li.deliveredQuantity} x ${li.orderLineItem.partNo}`)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payments */}
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h2 className="text-xl font-semibold mb-3">Payments</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-2 border-b">Date</th>
                <th className="p-2 border-b">Type</th>
                <th className="p-2 border-b text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {orderDetails.payments.map((payment) => (
                <tr key={payment.id} className="odd:bg-white even:bg-sh-stripe">
                  <td className="p-2 border-b">
                    {format(parseLocalDate(payment.paymentDate), "PPP")}
                  </td>
                  <td className="p-2 border-b">{payment.paymentType}</td>
                  <td className="p-2 border-b text-right">
                    {formatCurrency(payment.paymentAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cancel Line Item Modal */}
      {cancelModalItem && (
        <Modal
          title={`Cancel: ${cancelModalItem.productName}`}
          onClose={() => setCancelModalItem(null)}
          onSave={handleCancelLineItem}
          saveLabel="Cancel Item"
        >
          <p className="text-sm text-sh-gray mb-3">
            This will mark the item as cancelled. It will remain on the order for record-keeping but
            won&apos;t count toward totals.
          </p>
          <label htmlFor="cancel-reason" className="block text-sm font-medium mb-1">
            Reason for cancellation
          </label>
          <select
            id="cancel-reason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm mb-2"
          >
            <option value="">Select a reason...</option>
            <option value="Customer changed mind">Customer changed mind</option>
            <option value="Fabric/finish discontinued">Fabric/finish discontinued</option>
            <option value="Fabric/finish out of stock">Fabric/finish out of stock</option>
            <option value="Vendor unable to produce">Vendor unable to produce</option>
            <option value="Price change unacceptable">Price change unacceptable</option>
            <option value="Duplicate entry">Duplicate entry</option>
            <option value="Other">Other</option>
          </select>
          {cancelReason === "Other" && (
            <input
              type="text"
              placeholder="Specify reason..."
              value=""
              onChange={(e) => setCancelReason(e.target.value)}
              aria-label="Specify cancellation reason"
              className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm"
            />
          )}
        </Modal>
      )}

      {/* Salesperson Modal */}
      {showSalespersonModal && (
        <Modal
          title="Change Salesperson"
          onClose={() => setShowSalespersonModal(false)}
          onSave={handleSaveSalesperson}
          saving={salespersonSaving}
          saveLabel="Save"
        >
          <label htmlFor="edit-salesperson" className="block text-sm font-medium mb-1">
            Primary Salesperson
          </label>
          <select
            id="edit-salesperson"
            value={editSalesPersonId ?? ""}
            onChange={(e) => {
              const val = e.target.value ? Number.parseInt(e.target.value) : null;
              setEditSalesPersonId(val);
              if (val !== null && editSplitWithId === val) {
                setEditSplitWithId(null);
              }
            }}
            className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm mb-4"
          >
            <option value="">-- Select --</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>

          <label htmlFor="edit-split-with" className="block text-sm font-medium mb-1">
            Split With (optional)
          </label>
          <select
            id="edit-split-with"
            value={editSplitWithId ?? ""}
            onChange={(e) =>
              setEditSplitWithId(e.target.value ? Number.parseInt(e.target.value) : null)
            }
            className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm mb-2"
          >
            <option value="">-- None --</option>
            {staffList
              .filter((s) => s.id !== editSalesPersonId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
          </select>

          {editSplitWithId && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-2">
              Sales credit will be split 50/50 between the two salespeople for reporting and bonus
              calculation.
            </p>
          )}
        </Modal>
      )}

      {/* Replace Line Item Modal */}
      {replaceModalItem && (
        <Modal
          title={`Replace: ${replaceModalItem.productName}`}
          onClose={() => setReplaceModalItem(null)}
          onSave={handleReplaceLineItem}
          saveLabel="Replace Item"
        >
          <p className="text-sm text-sh-gray mb-3">
            The original item will be marked as &quot;Replaced&quot; and a new line item will be
            created with the same quantity and price.
          </p>
          <label htmlFor="replace-reason" className="block text-sm font-medium mb-1">
            Reason
          </label>
          <select
            id="replace-reason"
            value={replaceReason}
            onChange={(e) => setReplaceReason(e.target.value)}
            className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm mb-3"
          >
            <option value="">Select a reason...</option>
            <option value="Fabric out of stock">Fabric out of stock</option>
            <option value="Customer reselection">Customer reselection</option>
            <option value="Vendor substitution">Vendor substitution</option>
            <option value="Other">Other</option>
          </select>
          <label htmlFor="replacement-name" className="block text-sm font-medium mb-1">
            Replacement Product Name
          </label>
          <input
            id="replacement-name"
            type="text"
            value={replacementName}
            onChange={(e) => setReplacementName(e.target.value)}
            className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm mb-3"
            placeholder="e.g., Same frame, new fabric"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="replacement-partno" className="block text-sm font-medium mb-1">
                Part # (optional)
              </label>
              <input
                id="replacement-partno"
                type="text"
                value={replacementPartNo}
                onChange={(e) => setReplacementPartNo(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor="replacement-grade" className="block text-sm font-medium mb-1">
                Grade (optional)
              </label>
              <input
                id="replacement-grade"
                type="text"
                value={replacementGrade}
                onChange={(e) => setReplacementGrade(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm"
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
