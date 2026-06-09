"use client";

// /app/src/app/(dashboard)/app/sales/proposals/[id]/ProposalDetailView.tsx
//
// B2B Proposal editor (Client / Items / Presentation / Review tabs). App Router
// port of the legacy sales/proposals/[id] body (minus MainLayout chrome, which
// the (dashboard) layout supplies). Reads + writes the shared REST endpoints
// (/api/proposals/:id and its line-item / image / pdf / convert sub-routes),
// which stay REST. The id arrives as a prop from the server page (params awaited
// there).

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Save, FileDown, ShoppingCart, Plus, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

// --- Types ---

interface ProposalImage {
  id: number;
  imageUrl: string;
  caption: string | null;
  isPrimary: boolean;
}

interface ProposalLineItem {
  id: number;
  sortOrder: number;
  type: string;
  productId: number | null;
  itemName: string;
  itemDescription: string | null;
  vendorName: string | null;
  partNumber: string | null;
  cost: string;
  retailPrice: string;
  quantity: number;
  selectedGrade: string | null;
  selectedFinish: string | null;
  selectedOptions: string | null;
  itemNotes: string | null;
  showInOutput: boolean;
  images: ProposalImage[];
  product: { imageUrl: string | null } | null;
}

interface ProposalData {
  id: number;
  proposalNumber: string;
  status: string;
  customerId: number | null;
  projectName: string | null;
  companyName: string | null;
  coverLetter: string | null;
  terms: string | null;
  internalNotes: string | null;
  salesPersonId: number | null;
  salesOrderId: number | null;
  expiresAt: string | null;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    tradeCompanyName: string | null;
  } | null;
  salesPerson: { id: number; displayName: string } | null;
  lineItems: ProposalLineItem[];
}

// --- Helpers ---

function marginPct(cost: number, retail: number): string {
  if (retail === 0) return "0%";
  return `${(((retail - cost) / retail) * 100).toFixed(1)}%`;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  SENT: "bg-sh-blue/15 text-sh-blue",
  ACCEPTED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-700",
  EXPIRED: "bg-amber-100 text-amber-700",
};

const TABS = ["Client", "Items", "Presentation", "Review"] as const;
type TabName = (typeof TABS)[number];

// --- View ---

export function ProposalDetailView({ id }: { id: string }) {
  const router = useRouter();
  const currency = useMoneyFormatter();
  const [proposal, setProposal] = useState<ProposalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabName>("Client");

  // Editable header fields
  const [projectName, setProjectName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [terms, setTerms] = useState("");
  const [internalNotes, setInternalNotes] = useState("");

  // Custom item form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newItem, setNewItem] = useState({
    itemName: "",
    vendorName: "",
    partNumber: "",
    itemDescription: "",
    cost: "",
    retailPrice: "",
    quantity: "1",
  });

  const fetchProposal = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const { data } = await axios.get(`/api/proposals/${encodeURIComponent(String(id))}`);
      setProposal(data);
      setProjectName(data.projectName || "");
      setCompanyName(data.companyName || "");
      setCoverLetter(data.coverLetter || "");
      setTerms(data.terms || "");
      setInternalNotes(data.internalNotes || "");
    } catch {
      toast.error("Failed to load proposal");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchProposal();
  }, [fetchProposal]);

  async function handleSave() {
    if (!proposal) return;
    setSaving(true);
    try {
      await axios.put(`/api/proposals/${proposal.id}`, {
        projectName,
        companyName,
        coverLetter,
        terms,
        internalNotes,
      });
      toast.success("Proposal saved");
      fetchProposal();
    } catch {
      toast.error("Failed to save proposal");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddItem() {
    if (!proposal || !newItem.itemName || !newItem.cost || !newItem.retailPrice) {
      toast.error("Name, cost, and retail price are required");
      return;
    }
    try {
      await axios.post(`/api/proposals/${proposal.id}/line-items`, {
        type: "CUSTOM",
        itemName: newItem.itemName,
        vendorName: newItem.vendorName || null,
        partNumber: newItem.partNumber || null,
        itemDescription: newItem.itemDescription || null,
        cost: Number(newItem.cost),
        retailPrice: Number(newItem.retailPrice),
        quantity: Number(newItem.quantity) || 1,
      });
      setNewItem({
        itemName: "",
        vendorName: "",
        partNumber: "",
        itemDescription: "",
        cost: "",
        retailPrice: "",
        quantity: "1",
      });
      setShowAddForm(false);
      fetchProposal();
    } catch {
      toast.error("Failed to add item");
    }
  }

  async function handleDeleteItem(lineId: number) {
    if (!proposal) return;
    try {
      await axios.delete(`/api/proposals/${proposal.id}/line-items/${lineId}`);
      fetchProposal();
    } catch {
      toast.error("Failed to delete item");
    }
  }

  async function handleUpdateItem(lineId: number, field: string, value: string | number) {
    if (!proposal) return;
    try {
      await axios.put(`/api/proposals/${proposal.id}/line-items/${lineId}`, {
        [field]: value,
      });
      fetchProposal();
    } catch {
      toast.error("Failed to update item");
    }
  }

  async function handleImageUpload(lineId: number, file: File) {
    if (!proposal) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      await axios.post(`/api/proposals/${proposal.id}/line-items/${lineId}/images`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      fetchProposal();
    } catch {
      toast.error("Failed to upload image");
    }
  }

  async function handleDeleteImage(lineId: number, imgId: number) {
    if (!proposal) return;
    try {
      await axios.delete(`/api/proposals/${proposal.id}/line-items/${lineId}/images/${imgId}`);
      fetchProposal();
    } catch {
      toast.error("Failed to delete image");
    }
  }

  async function handleGeneratePdf() {
    if (!proposal) return;
    try {
      const response = await axios.post(
        `/api/proposals/${proposal.id}/generate-pdf`,
        {},
        { responseType: "blob" },
      );
      const blob = new Blob([response.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${proposal.proposalNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("PDF downloaded");
    } catch {
      toast.error("Failed to generate PDF");
    }
  }

  async function handleConvertToOrder() {
    if (!proposal) return;
    try {
      const { data } = await axios.post(`/api/proposals/${proposal.id}/convert-to-order`);
      toast.success(`Order ${data.orderno} created`);
      router.push(`/app/sales/orders/${data.orderId}`);
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to convert to order";
      toast.error(msg);
    }
  }

  if (loading || !proposal) {
    return <div className="py-16 text-center text-sh-gray font-serif">Loading...</div>;
  }

  const items = proposal.lineItems;
  const totalCost = items.reduce((s, li) => s + Number(li.cost) * li.quantity, 0);
  const totalRetail = items.reduce((s, li) => s + Number(li.retailPrice) * li.quantity, 0);
  const blendedMargin = marginPct(totalCost, totalRetail);
  const isEditable = proposal.status === "DRAFT" || proposal.status === "SENT";

  return (
    <div className="py-2 space-y-4 font-serif">
      {/* Breadcrumb + header */}
      <nav className="text-sm text-sh-gray">
        <Link href="/app/sales" className="hover:underline">
          Sales
        </Link>
        <span className="mx-2">/</span>
        <Link href="/app/sales/proposals" className="hover:underline">
          Proposals
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">{proposal.proposalNumber}</span>
      </nav>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-sh-navy">{proposal.proposalNumber}</h1>
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[proposal.status] || ""}`}
          >
            {proposal.status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isEditable && (
            <Button
              variant="outline"
              onClick={handleSave}
              disabled={saving}
              className="min-h-[44px]"
            >
              <Save className="w-4 h-4 mr-1" />
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          {items.length > 0 && (
            <Button variant="outline" onClick={handleGeneratePdf} className="min-h-[44px]">
              <FileDown className="w-4 h-4 mr-1" />
              PDF
            </Button>
          )}
          {isEditable && items.length > 0 && !proposal.salesOrderId && (
            <Button onClick={handleConvertToOrder} className="min-h-[44px]">
              <ShoppingCart className="w-4 h-4 mr-1" />
              Convert to Order
            </Button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-sh-gray/15">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-3 text-sm font-medium min-h-[44px] transition border-b-2 ${
              activeTab === tab
                ? "border-sh-blue text-sh-blue"
                : "border-transparent text-sh-gray hover:text-sh-black"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab: Client */}
      {activeTab === "Client" && (
        <div className="space-y-4 max-w-xl">
          <div>
            <label
              htmlFor="proposal-project-name"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
            >
              Project Name
            </label>
            <input
              id="proposal-project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g., Marriott Lobby Renovation"
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
              disabled={!isEditable}
            />
          </div>
          <div>
            <label
              htmlFor="proposal-company-name"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
            >
              Company Name
            </label>
            <input
              id="proposal-company-name"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Client company name"
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
              disabled={!isEditable}
            />
          </div>
          {proposal.customer && (
            <div className="bg-sh-linen rounded-lg p-4">
              <p className="text-sm font-semibold text-sh-navy">
                {[proposal.customer.firstName, proposal.customer.lastName]
                  .filter(Boolean)
                  .join(" ")}
              </p>
              {proposal.customer.email && (
                <p className="text-xs text-sh-gray">{proposal.customer.email}</p>
              )}
              {proposal.customer.phone && (
                <p className="text-xs text-sh-gray">{proposal.customer.phone}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab: Items */}
      {activeTab === "Items" && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="bg-sh-linen rounded-lg p-4 flex flex-wrap gap-6 text-sm">
            <div>
              Items: <strong className="text-sh-navy">{items.length}</strong>
            </div>
            <div>
              Total Cost: <strong className="text-sh-navy">{currency(totalCost)}</strong>
            </div>
            <div>
              Total Retail: <strong className="text-sh-navy">{currency(totalRetail)}</strong>
            </div>
            <div>
              Blended Margin: <strong className="text-sh-navy">{blendedMargin}</strong>
            </div>
          </div>

          {/* Line items */}
          {items.map((li) => (
            <div key={li.id} className="bg-white rounded-xl border border-sh-gray/15 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-sh-navy">{li.itemName}</span>
                    <span className="text-xs text-sh-gray px-1.5 py-0.5 rounded bg-sh-gray/10">
                      {li.type}
                    </span>
                  </div>
                  {(li.vendorName || li.partNumber) && (
                    <p className="text-xs text-sh-gray">
                      {[li.vendorName, li.partNumber].filter(Boolean).join(" | ")}
                    </p>
                  )}
                  {li.itemDescription && (
                    <p className="text-xs text-sh-gray mt-1">{li.itemDescription}</p>
                  )}
                </div>
                {isEditable && (
                  <button
                    onClick={() => handleDeleteItem(li.id)}
                    className="text-red-400 hover:text-red-600 min-h-[44px] min-w-[44px] flex items-center justify-center"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Pricing row */}
              <div className="flex flex-wrap items-center gap-4 mt-3">
                <div>
                  <label htmlFor={`li-cost-${li.id}`} className="text-xs text-sh-gray">
                    Cost
                  </label>
                  <input
                    id={`li-cost-${li.id}`}
                    type="number"
                    step="0.01"
                    value={li.cost}
                    onChange={(e) => handleUpdateItem(li.id, "cost", Number(e.target.value))}
                    className="block w-28 border border-sh-gray/30 rounded px-2 py-1 text-sm min-h-[44px]"
                    disabled={!isEditable}
                  />
                </div>
                <div>
                  <label htmlFor={`li-retail-${li.id}`} className="text-xs text-sh-gray">
                    Retail
                  </label>
                  <input
                    id={`li-retail-${li.id}`}
                    type="number"
                    step="0.01"
                    value={li.retailPrice}
                    onChange={(e) => handleUpdateItem(li.id, "retailPrice", Number(e.target.value))}
                    className="block w-28 border border-sh-gray/30 rounded px-2 py-1 text-sm min-h-[44px]"
                    disabled={!isEditable}
                  />
                </div>
                <div>
                  <label htmlFor={`li-qty-${li.id}`} className="text-xs text-sh-gray">
                    Qty
                  </label>
                  <input
                    id={`li-qty-${li.id}`}
                    type="number"
                    min="1"
                    value={li.quantity}
                    onChange={(e) => handleUpdateItem(li.id, "quantity", Number(e.target.value))}
                    className="block w-16 border border-sh-gray/30 rounded px-2 py-1 text-sm min-h-[44px]"
                    disabled={!isEditable}
                  />
                </div>
                <div className="pt-4">
                  <span className="text-xs text-sh-gray">
                    Margin: {marginPct(Number(li.cost), Number(li.retailPrice))}
                  </span>
                </div>
                <div className="pt-4">
                  <span className="text-sm font-semibold text-sh-navy">
                    {currency(Number(li.retailPrice) * li.quantity)}
                  </span>
                </div>
              </div>

              {/* Notes */}
              {isEditable && (
                <div className="mt-3">
                  <input
                    type="text"
                    value={li.itemNotes || ""}
                    onChange={(e) => handleUpdateItem(li.id, "itemNotes", e.target.value)}
                    placeholder="Item notes (shown to client)"
                    className="w-full border border-sh-gray/20 rounded px-2 py-1 text-xs min-h-[44px]"
                  />
                </div>
              )}

              {/* Images */}
              <div className="flex flex-wrap gap-2 mt-3">
                {li.images.map((img) => (
                  <div
                    key={img.id}
                    className="relative w-20 h-20 rounded overflow-hidden border border-sh-gray/20"
                  >
                    <img
                      src={`/api/uploads${img.imageUrl}`}
                      alt={img.caption || ""}
                      className="w-full h-full object-cover"
                    />
                    {isEditable && (
                      <button
                        onClick={() => handleDeleteImage(li.id, img.id)}
                        className="absolute top-0.5 right-0.5 bg-white/80 rounded-full p-0.5"
                      >
                        <X className="w-3 h-3 text-red-500" />
                      </button>
                    )}
                  </div>
                ))}
                {isEditable && (
                  <label className="w-20 h-20 rounded border-2 border-dashed border-sh-gray/30 flex items-center justify-center cursor-pointer hover:border-sh-blue transition">
                    <Upload className="w-5 h-5 text-sh-gray" />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleImageUpload(li.id, file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
          ))}

          {/* Add custom item */}
          {isEditable && !showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full py-4 border-2 border-dashed border-sh-gray/30 rounded-xl text-sh-gray hover:border-sh-blue hover:text-sh-blue transition flex items-center justify-center gap-2 min-h-[44px]"
            >
              <Plus className="w-5 h-5" />
              Add Custom Item
            </button>
          )}

          {isEditable && showAddForm && (
            <div className="bg-white rounded-xl border border-sh-blue/30 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-sh-navy">Add Custom Item</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={newItem.itemName}
                  onChange={(e) => setNewItem({ ...newItem, itemName: e.target.value })}
                  placeholder="Item name *"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
                <input
                  type="text"
                  value={newItem.vendorName}
                  onChange={(e) => setNewItem({ ...newItem, vendorName: e.target.value })}
                  placeholder="Vendor"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
                <input
                  type="text"
                  value={newItem.partNumber}
                  onChange={(e) => setNewItem({ ...newItem, partNumber: e.target.value })}
                  placeholder="Part number"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
                <input
                  type="text"
                  value={newItem.itemDescription}
                  onChange={(e) => setNewItem({ ...newItem, itemDescription: e.target.value })}
                  placeholder="Description"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={newItem.cost}
                  onChange={(e) => setNewItem({ ...newItem, cost: e.target.value })}
                  placeholder="Cost *"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={newItem.retailPrice}
                  onChange={(e) => setNewItem({ ...newItem, retailPrice: e.target.value })}
                  placeholder="Retail price *"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
                <input
                  type="number"
                  min="1"
                  value={newItem.quantity}
                  onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })}
                  placeholder="Qty"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-h-[44px]"
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleAddItem} className="min-h-[44px]">
                  Add Item
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowAddForm(false)}
                  className="min-h-[44px]"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab: Presentation */}
      {activeTab === "Presentation" && (
        <div className="space-y-4 max-w-2xl">
          <div>
            <label
              htmlFor="proposal-cover-letter"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
            >
              Cover Letter
            </label>
            <textarea
              id="proposal-cover-letter"
              value={coverLetter}
              onChange={(e) => setCoverLetter(e.target.value)}
              rows={6}
              placeholder="Introduction text for the proposal cover page..."
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
              disabled={!isEditable}
            />
          </div>
          <div>
            <label
              htmlFor="proposal-terms"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
            >
              Terms and Conditions
            </label>
            <textarea
              id="proposal-terms"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={4}
              placeholder="Payment terms, delivery conditions, warranty information..."
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
              disabled={!isEditable}
            />
          </div>
          <div>
            <label
              htmlFor="proposal-internal-notes"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
            >
              Internal Notes
            </label>
            <p className="text-xs text-amber-600 mb-1">Not shown to the client</p>
            <textarea
              id="proposal-internal-notes"
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={3}
              placeholder="Notes for internal reference only..."
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
              disabled={!isEditable}
            />
          </div>
        </div>
      )}

      {/* Tab: Review */}
      {activeTab === "Review" && (
        <div className="space-y-6">
          {/* Project info */}
          <div className="bg-white rounded-xl border border-sh-gray/15 p-5">
            <h3 className="text-sm font-semibold text-sh-navy uppercase tracking-widest mb-3">
              Proposal Details
            </h3>
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <span className="text-sh-gray">Project:</span>
              <span className="text-sh-navy">{projectName || "—"}</span>
              <span className="text-sh-gray">Company:</span>
              <span className="text-sh-navy">{companyName || "—"}</span>
              <span className="text-sh-gray">Customer:</span>
              <span className="text-sh-navy">
                {proposal.customer
                  ? [proposal.customer.firstName, proposal.customer.lastName]
                      .filter(Boolean)
                      .join(" ")
                  : "—"}
              </span>
              <span className="text-sh-gray">Prepared by:</span>
              <span className="text-sh-navy">{proposal.salesPerson?.displayName || "—"}</span>
            </div>
          </div>

          {/* Line item summary */}
          <div className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/15 bg-sh-stripe">
                  <th className="text-left px-4 py-3 font-medium text-sh-gray">Item</th>
                  <th className="text-right px-4 py-3 font-medium text-sh-gray">Cost</th>
                  <th className="text-right px-4 py-3 font-medium text-sh-gray">Retail</th>
                  <th className="text-right px-4 py-3 font-medium text-sh-gray">Qty</th>
                  <th className="text-right px-4 py-3 font-medium text-sh-gray">Line Total</th>
                  <th className="text-right px-4 py-3 font-medium text-sh-gray">Margin</th>
                </tr>
              </thead>
              <tbody>
                {items.map((li, idx) => (
                  <tr key={li.id} className={idx % 2 === 1 ? "bg-sh-stripe" : ""}>
                    <td className="px-4 py-2 text-sh-navy">{li.itemName}</td>
                    <td className="px-4 py-2 text-right text-sh-gray">
                      {currency(Number(li.cost))}
                    </td>
                    <td className="px-4 py-2 text-right">{currency(Number(li.retailPrice))}</td>
                    <td className="px-4 py-2 text-right text-sh-gray">{li.quantity}</td>
                    <td className="px-4 py-2 text-right font-medium">
                      {currency(Number(li.retailPrice) * li.quantity)}
                    </td>
                    <td className="px-4 py-2 text-right text-sh-gray">
                      {marginPct(Number(li.cost), Number(li.retailPrice))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-sh-navy">
                  <td className="px-4 py-3 font-semibold text-sh-navy">Totals</td>
                  <td className="px-4 py-3 text-right text-sh-gray">{currency(totalCost)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{currency(totalRetail)}</td>
                  <td className="px-4 py-3 text-right text-sh-gray">
                    {items.reduce((s, li) => s + li.quantity, 0)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-sh-navy">
                    {currency(totalRetail)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{blendedMargin}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {proposal.salesOrderId && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm">
              This proposal has been converted to{" "}
              <Link
                href={`/app/sales/orders/${proposal.salesOrderId}`}
                className="text-sh-blue hover:underline font-semibold"
              >
                Sales Order
              </Link>
              .
            </div>
          )}
        </div>
      )}
    </div>
  );
}
