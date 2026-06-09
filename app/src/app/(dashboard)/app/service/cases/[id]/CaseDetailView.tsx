"use client";

// /app/src/app/(dashboard)/app/service/cases/[id]/CaseDetailView.tsx
//
// Service case detail: status/assignee changers, tasks (with SO/PO linking),
// activity notes, and resolution. App Router port of the legacy
// pages/service/cases/[id].tsx body (minus MainLayout chrome, which comes from
// the (dashboard) layout). Reads the shared /api/service/cases/[id] + notes +
// tasks + staff + settings + sales/orders + purchasing/orders REST endpoints.
// The case id arrives as a prop from the server page.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format, differenceInDays } from "date-fns";
import Link from "next/link";
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";

type StaffOption = { id: number; displayName: string };

type CaseNote = {
  id: number;
  note: string;
  isInternal: boolean;
  created: string;
  author: { id: number; displayName: string } | null;
  // Snapshot display name from an external source (e.g. a Google Sheet
  // threaded comment whose author is no longer a current StaffMember).
  // Set by the Customer Service Sheet importer.
  authorDisplayName: string | null;
  createdBy: string | null;
};

type LinkedOrder = { id: number; orderno: string } | null;
type LinkedPO = { id: number; poNumber: string } | null;

type CaseTask = {
  id: number;
  title: string;
  description: string | null;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  waitingOn: string | null;
  dueDate: string | null;
  assignedTo: { id: number; displayName: string } | null;
  linkedOrder: LinkedOrder;
  linkedPurchaseOrder: LinkedPO;
};

type ClosedStatus = { id: number; name: string };
type StatusOption = { id: number; name: string; isClosed: boolean; color: string | null };

type CaseDetail = {
  id: number;
  caseNumber: string;
  summary: string;
  storeLocation: string | null;
  preferredContact: string | null;
  itemDescription: string | null;
  partNo: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  created: string;
  type: { id: number; name: string };
  status: { id: number; name: string; color: string | null; isClosed: boolean };
  priority: { id: number; name: string; color: string | null };
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  salesOrder: { id: number; orderno: string } | null;
  purchaseOrder: { id: number; poNumber: string; status: string | null } | null;
  vendor: { id: number; name: string } | null;
  salesPerson: { id: number; displayName: string } | null;
  assignedTo: { id: number; displayName: string } | null;
  notes: CaseNote[];
  tasks: CaseTask[];
};

type OrderSearchResult = { id: number; orderno: string; customerName: string | null };
type POSearchResult = { id: number; poNumber: string; vendorName: string | null };

const TASK_STATUS_CYCLE: Record<string, string> = {
  PENDING: "IN_PROGRESS",
  IN_PROGRESS: "COMPLETED",
  COMPLETED: "PENDING",
};

const TASK_STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-sh-gray/10 text-sh-gray",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const WAITING_ON_OPTIONS = ["None", "Vendor", "Customer"];

function formatAge(ageDays: number): string {
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "1 day ago";
  return `${ageDays} days ago`;
}

export function CaseDetailView({ id }: { id: string }) {
  const [caseData, setCaseData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<StaffOption[]>([]);

  // Note form
  const [noteText, setNoteText] = useState("");
  const [noteInternal, setNoteInternal] = useState(true);
  const [addingNote, setAddingNote] = useState(false);

  // Task form
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssigneeId, setTaskAssigneeId] = useState("");
  const [taskWaitingOn, setTaskWaitingOn] = useState("None");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [addingTask, setAddingTask] = useState(false);

  // Order link modal
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkModalType, setLinkModalType] = useState<"order" | "po">("order");
  const [linkModalTaskId, setLinkModalTaskId] = useState<number | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkResults, setLinkResults] = useState<OrderSearchResult[] | POSearchResult[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);

  // Resolution
  const [showResolve, setShowResolve] = useState(false);
  const [resolveStatusId, setResolveStatusId] = useState("");
  const [resolveNotes, setResolveNotes] = useState("");
  const [closedStatuses, setClosedStatuses] = useState<ClosedStatus[]>([]);
  const [allStatuses, setAllStatuses] = useState<StatusOption[]>([]);
  const [resolving, setResolving] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);

  const fetchCase = useCallback(async () => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/service/cases/${encodeURIComponent(id)}`);
      setCaseData(res.data);
    } catch {
      toast.error("Failed to load case");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCase();
  }, [fetchCase]);

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const [staffRes, statusRes] = await Promise.all([
          axios.get("/api/staff?limit=100"),
          axios.get("/api/service/settings/statuses"),
        ]);
        setStaff(staffRes.data.staff || []);
        const statuses: StatusOption[] = statusRes.data.statuses || [];
        setAllStatuses(statuses);
        setClosedStatuses(statuses.filter((s) => s.isClosed));
      } catch {
        // Non-critical
      }
    };
    loadOptions();
  }, []);

  const handleAssigneeChange = async (newAssigneeId: string) => {
    if (!caseData) return;
    try {
      await axios.put(`/api/service/cases/${caseData.id}`, {
        assignedToId: newAssigneeId ? Number.parseInt(newAssigneeId) : null,
      });
      toast.success("Assignee updated");
      fetchCase();
    } catch {
      toast.error("Failed to update assignee");
    }
  };

  const handleStatusChange = async (newStatusId: string) => {
    if (!caseData) return;
    const next = Number.parseInt(newStatusId);
    if (!Number.isFinite(next) || next === caseData.status.id) return;
    setChangingStatus(true);
    try {
      await axios.put(`/api/service/cases/${caseData.id}`, { statusId: next });
      toast.success("Status updated");
      await fetchCase();
    } catch {
      toast.error("Failed to update status");
    } finally {
      setChangingStatus(false);
    }
  };

  const handleAddNote = async () => {
    if (!caseData || !noteText.trim()) return;
    setAddingNote(true);
    try {
      await axios.post(`/api/service/cases/${caseData.id}/notes`, {
        note: noteText.trim(),
        isInternal: noteInternal,
      });
      setNoteText("");
      setNoteInternal(true);
      toast.success("Note added");
      fetchCase();
    } catch {
      toast.error("Failed to add note");
    } finally {
      setAddingNote(false);
    }
  };

  const handleAddTask = async () => {
    if (!caseData || !taskTitle.trim()) return;
    setAddingTask(true);
    try {
      const payload: Record<string, unknown> = { title: taskTitle.trim() };
      if (taskAssigneeId) payload.assignedToId = Number.parseInt(taskAssigneeId);
      if (taskWaitingOn !== "None") payload.waitingOn = taskWaitingOn;
      if (taskDueDate) payload.dueDate = taskDueDate;

      await axios.post(`/api/service/cases/${caseData.id}/tasks`, payload);
      setTaskTitle("");
      setTaskAssigneeId("");
      setTaskWaitingOn("None");
      setTaskDueDate("");
      toast.success("Task added");
      fetchCase();
    } catch {
      toast.error("Failed to add task");
    } finally {
      setAddingTask(false);
    }
  };

  const handleCycleTaskStatus = async (task: CaseTask) => {
    const nextStatus = TASK_STATUS_CYCLE[task.status];
    if (!nextStatus) return;
    try {
      await axios.put(`/api/service/tasks/${task.id}`, { status: nextStatus });
      fetchCase();
    } catch {
      toast.error("Failed to update task");
    }
  };

  const handleDeleteTask = async (taskId: number) => {
    try {
      await axios.delete(`/api/service/tasks/${taskId}`);
      toast.success("Task removed");
      fetchCase();
    } catch {
      toast.error("Failed to remove task");
    }
  };

  const openLinkModal = (taskId: number, type: "order" | "po") => {
    setLinkModalTaskId(taskId);
    setLinkModalType(type);
    setLinkSearch("");
    setLinkResults([]);
    setLinkModalOpen(true);
  };

  const handleLinkSearch = async () => {
    if (!linkSearch.trim()) return;
    setLinkSearching(true);
    try {
      if (linkModalType === "order") {
        const res = await axios.get("/api/sales/orders", {
          params: { search: linkSearch.trim(), limit: 10 },
        });
        const orders = (res.data.salesOrders || []).map(
          (o: {
            id: number;
            orderno: string;
            customer?: { firstName?: string; lastName?: string };
          }) => ({
            id: o.id,
            orderno: o.orderno,
            customerName: o.customer
              ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(" ")
              : null,
          }),
        );
        setLinkResults(orders);
      } else {
        const res = await axios.get("/api/purchasing/orders", {
          params: { search: linkSearch.trim(), limit: 10 },
        });
        const pos = (res.data.orders || []).map(
          (p: { id: number; poNumber: string; vendorName?: string }) => ({
            id: p.id,
            poNumber: p.poNumber,
            vendorName: p.vendorName || null,
          }),
        );
        setLinkResults(pos);
      }
    } catch {
      toast.error("Search failed");
    } finally {
      setLinkSearching(false);
    }
  };

  const handleSelectLink = async (selectedId: number) => {
    if (!linkModalTaskId) return;
    try {
      const payload: Record<string, unknown> =
        linkModalType === "order"
          ? { linkedOrderId: selectedId }
          : { linkedPurchaseOrderId: selectedId };
      await axios.put(`/api/service/tasks/${linkModalTaskId}`, payload);
      toast.success("Order linked");
      setLinkModalOpen(false);
      fetchCase();
    } catch {
      toast.error("Failed to link order");
    }
  };

  const handleUnlink = async (taskId: number, type: "order" | "po") => {
    try {
      const payload: Record<string, unknown> =
        type === "order" ? { linkedOrderId: null } : { linkedPurchaseOrderId: null };
      await axios.put(`/api/service/tasks/${taskId}`, payload);
      toast.success("Order unlinked");
      fetchCase();
    } catch {
      toast.error("Failed to unlink order");
    }
  };

  const handleResolve = async () => {
    if (!caseData || !resolveStatusId) return;
    setResolving(true);
    try {
      await axios.put(`/api/service/cases/${caseData.id}`, {
        statusId: Number.parseInt(resolveStatusId),
        resolutionNotes: resolveNotes.trim() || null,
        resolvedAt: new Date().toISOString(),
      });
      toast.success("Case resolved");
      setShowResolve(false);
      fetchCase();
    } catch {
      toast.error("Failed to resolve case");
    } finally {
      setResolving(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray py-8">Loading case...</p>;
  }

  if (!caseData) {
    return <p className="text-sh-gray py-8">Case not found.</p>;
  }

  const ageDays = differenceInDays(new Date(), new Date(caseData.created));

  const badgeStyle = (color: string | null) => {
    if (!color) return "bg-sh-gray/10 text-sh-gray";
    return "text-white";
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl text-sh-blue font-semibold">{caseData.caseNumber}</h1>
          {/* Inline status changer — replaces a static badge so the
              operator can move a case Service Call → Needs Attention →
              Waiting on Vendor etc. without leaving the page. The
              "Resolve" form below still exists for closing with
              resolutionNotes. */}
          <label htmlFor="case-status-select" className="sr-only">
            Status
          </label>
          <select
            id="case-status-select"
            value={caseData.status.id}
            onChange={(e) => handleStatusChange(e.target.value)}
            disabled={changingStatus || allStatuses.length === 0}
            className="text-xs px-2 py-1 rounded border-0 text-white font-medium cursor-pointer focus:outline-none focus:ring-2 focus:ring-sh-blue"
            style={
              caseData.status.color
                ? { backgroundColor: caseData.status.color }
                : { backgroundColor: "#6b7280" }
            }
          >
            {allStatuses.length === 0 ? (
              <option value={caseData.status.id} style={{ color: "#000" }}>
                {caseData.status.name}
              </option>
            ) : (
              allStatuses.map((s) => (
                <option key={s.id} value={s.id} style={{ color: "#000" }}>
                  {s.name}
                  {s.isClosed ? " (closed)" : ""}
                </option>
              ))
            )}
          </select>
          <span
            className={`text-xs px-2 py-1 rounded ${badgeStyle(caseData.priority.color)}`}
            style={
              caseData.priority.color ? { backgroundColor: caseData.priority.color } : undefined
            }
          >
            {caseData.priority.name}
          </span>
          <span className="text-xs px-2 py-1 rounded bg-sh-gray/10 text-sh-black">
            {caseData.type.name}
          </span>
          <span className="text-sm text-sh-gray">
            Opened {format(new Date(caseData.created), "MMM d, yyyy")} · {formatAge(ageDays)}
          </span>
        </div>
        <Link href="/app/service">
          <Button variant="outline" size="sm">
            Back to Cases
          </Button>
        </Link>
      </div>

      {/* Summary */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-4">
        <p className="text-sm text-sh-black">{caseData.summary}</p>
      </div>

      {/* Info cards row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Customer card */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-4">
          <h3 className="text-sm font-semibold text-sh-gray uppercase tracking-wide mb-3">
            Customer
          </h3>
          {caseData.customer ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium text-sh-black">
                {caseData.customer.firstName} {caseData.customer.lastName}
              </p>
              {caseData.customer.phone && <p className="text-sh-gray">{caseData.customer.phone}</p>}
              {caseData.customer.email && <p className="text-sh-gray">{caseData.customer.email}</p>}
              {caseData.preferredContact && (
                <p className="text-sh-gray">Preferred: {caseData.preferredContact}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-sh-gray">No customer linked</p>
          )}
        </div>

        {/* Order card */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-4">
          <h3 className="text-sm font-semibold text-sh-gray uppercase tracking-wide mb-3">Order</h3>
          {caseData.salesOrder || caseData.purchaseOrder ? (
            <div className="space-y-1 text-sm">
              {caseData.salesOrder && (
                <Link
                  href={`/app/sales/orders/${caseData.salesOrder.id}`}
                  className="block font-medium text-sh-blue hover:underline"
                >
                  Order #{caseData.salesOrder.orderno}
                </Link>
              )}
              {caseData.purchaseOrder && (
                <Link
                  href={`/app/purchasing/orders/${caseData.purchaseOrder.id}`}
                  className="block font-medium text-sh-blue hover:underline"
                >
                  PO #{caseData.purchaseOrder.poNumber}
                  {caseData.purchaseOrder.status && (
                    <span className="ml-2 text-xs text-sh-gray">
                      ({caseData.purchaseOrder.status})
                    </span>
                  )}
                </Link>
              )}
              {caseData.vendor && <p className="text-sh-gray">{caseData.vendor.name}</p>}
            </div>
          ) : (
            <p className="text-sm text-sh-gray">No linked order</p>
          )}
          {caseData.itemDescription && (
            <p className="text-sm text-sh-gray mt-2">Item: {caseData.itemDescription}</p>
          )}
          {caseData.partNo && <p className="text-sm text-sh-gray">Part #: {caseData.partNo}</p>}
        </div>
      </div>

      {/* Assignment row */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-4">
        <div className="flex flex-wrap gap-6 items-center text-sm">
          {caseData.salesPerson && (
            <div>
              <span className="text-sh-gray">Salesperson: </span>
              <span className="text-sh-black font-medium">{caseData.salesPerson.displayName}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-sh-gray">Assigned To:</span>
            <select
              value={caseData.assignedTo?.id || ""}
              onChange={(e) => handleAssigneeChange(e.target.value)}
              className="border border-sh-gray/30 rounded px-2 py-1 text-sm"
            >
              <option value="">Unassigned</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>
          {caseData.storeLocation && (
            <div>
              <span className="text-sh-gray">Location: </span>
              <span className="text-sh-black">{caseData.storeLocation}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tasks */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h3 className="text-lg font-semibold text-sh-black mb-4">Tasks</h3>

        {caseData.tasks.length === 0 ? (
          <p className="text-sm text-sh-gray mb-4">No tasks</p>
        ) : (
          <div className="space-y-1 mb-4">
            {caseData.tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-3 px-3 py-2 rounded hover:bg-sh-stripe/50 text-sm group"
              >
                <button
                  onClick={() => handleCycleTaskStatus(task)}
                  className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded cursor-pointer ${
                    task.status === "COMPLETED"
                      ? "bg-green-100 text-green-800"
                      : "bg-sh-gray/10 text-sh-gray"
                  }`}
                  title="Click to change status"
                >
                  {task.status === "COMPLETED" ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : task.status === "IN_PROGRESS" ? (
                    <svg
                      className="w-5 h-5 text-blue-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3"
                      />
                      <circle cx="12" cy="12" r="9" strokeWidth={2} />
                    </svg>
                  ) : (
                    <span className="w-5 h-5 rounded border-2 border-sh-gray/40 block" />
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <span
                    className={`text-sh-black ${task.status === "COMPLETED" ? "line-through text-sh-gray" : ""}`}
                  >
                    {task.title}
                  </span>
                  {task.description && (
                    <p className="text-xs text-sh-gray mt-0.5 truncate">{task.description}</p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-1">
                    {task.linkedOrder && (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Link
                          href={`/app/sales/orders/${task.linkedOrder.id}`}
                          className="text-sh-blue hover:underline"
                        >
                          SO #{task.linkedOrder.orderno}
                        </Link>
                        <button
                          onClick={() => handleUnlink(task.id, "order")}
                          className="text-sh-gray hover:text-red-600 ml-0.5"
                          title="Unlink order"
                        >
                          x
                        </button>
                      </span>
                    )}
                    {task.linkedPurchaseOrder && (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Link
                          href={`/app/purchasing/${task.linkedPurchaseOrder.id}`}
                          className="text-sh-blue hover:underline"
                        >
                          PO #{task.linkedPurchaseOrder.poNumber}
                        </Link>
                        <button
                          onClick={() => handleUnlink(task.id, "po")}
                          className="text-sh-gray hover:text-red-600 ml-0.5"
                          title="Unlink PO"
                        >
                          x
                        </button>
                      </span>
                    )}
                  </div>
                </div>

                <span
                  className={`text-xs px-2 py-0.5 rounded ${TASK_STATUS_COLORS[task.status] || ""}`}
                >
                  {task.status.replace("_", " ")}
                </span>

                {task.assignedTo && (
                  <span className="text-xs text-sh-gray">{task.assignedTo.displayName}</span>
                )}
                {task.waitingOn && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-800">
                    Waiting: {task.waitingOn}
                  </span>
                )}
                {task.dueDate && (
                  <span className="text-xs text-sh-gray">
                    Due {format(new Date(task.dueDate), "MMM d")}
                  </span>
                )}

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {!task.linkedOrder && (
                    <button
                      onClick={() => openLinkModal(task.id, "order")}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-sh-gray hover:text-sh-blue"
                      title="Link to Sales Order"
                    >
                      +SO
                    </button>
                  )}
                  {!task.linkedPurchaseOrder && (
                    <button
                      onClick={() => openLinkModal(task.id, "po")}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-sh-gray hover:text-sh-blue"
                      title="Link to Purchase Order"
                    >
                      +PO
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteTask(task.id)}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center text-xs text-sh-gray hover:text-red-600"
                    title="Remove task"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add Task form */}
        <div className="border-t border-sh-gray/10 pt-4">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[200px]">
              <input
                type="text"
                placeholder="Task title..."
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && taskTitle.trim()) handleAddTask();
                }}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <select
              value={taskAssigneeId}
              onChange={(e) => setTaskAssigneeId(e.target.value)}
              className="border border-sh-gray/30 rounded px-2 py-2 text-sm"
            >
              <option value="">Assignee...</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
            <select
              value={taskWaitingOn}
              onChange={(e) => setTaskWaitingOn(e.target.value)}
              className="border border-sh-gray/30 rounded px-2 py-2 text-sm"
            >
              {WAITING_ON_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === "None" ? "Not waiting" : `Waiting: ${o}`}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={taskDueDate}
              onChange={(e) => setTaskDueDate(e.target.value)}
              className="border border-sh-gray/30 rounded px-2 py-2 text-sm"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddTask}
              disabled={addingTask || !taskTitle.trim()}
            >
              {addingTask ? "Adding..." : "Add"}
            </Button>
          </div>
        </div>
      </div>

      {/* Activity Timeline */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h3 className="text-lg font-semibold text-sh-black mb-4">Activity</h3>

        {caseData.notes.length === 0 ? (
          <p className="text-sm text-sh-gray mb-4">No notes yet</p>
        ) : (
          <div className="space-y-3 mb-6">
            {caseData.notes.map((note) => (
              <div key={note.id} className="border-l-2 border-sh-gray/20 pl-4 py-1">
                <div className="flex items-center gap-2 text-xs text-sh-gray mb-1">
                  <span className="font-medium text-sh-black">
                    {note.author
                      ? note.author.displayName
                      : note.authorDisplayName || note.createdBy || "System"}
                  </span>
                  <span>{format(new Date(note.created), "MMM d, yyyy h:mm a")}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      note.isInternal ? "bg-sh-gray/10 text-sh-gray" : "bg-blue-50 text-blue-700"
                    }`}
                  >
                    {note.isInternal ? "Internal" : "External"}
                  </span>
                </div>
                <p className="text-sm text-sh-black whitespace-pre-wrap">{note.note}</p>
              </div>
            ))}
          </div>
        )}

        {/* Add Note form */}
        <div className="border-t border-sh-gray/10 pt-4">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
            placeholder="Add a note..."
            className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm mb-2"
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-sh-gray">
              <input
                type="checkbox"
                checked={noteInternal}
                onChange={(e) => setNoteInternal(e.target.checked)}
                className="rounded"
              />
              Internal note
            </label>
            <Button
              variant="primary"
              size="sm"
              onClick={handleAddNote}
              disabled={addingNote || !noteText.trim()}
            >
              {addingNote ? "Adding..." : "Add Note"}
            </Button>
          </div>
        </div>
      </div>

      {/* Resolution */}
      {!caseData.status.isClosed && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h3 className="text-lg font-semibold text-sh-black mb-4">Resolution</h3>
          {!showResolve ? (
            <Button variant="primary" size="sm" onClick={() => setShowResolve(true)}>
              Resolve Case
            </Button>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-sh-gray mb-1">Closed Status</label>
                <select
                  value={resolveStatusId}
                  onChange={(e) => setResolveStatusId(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">Select status...</option>
                  {closedStatuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-sh-gray mb-1">Resolution Notes</label>
                <textarea
                  value={resolveNotes}
                  onChange={(e) => setResolveNotes(e.target.value)}
                  rows={3}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                  placeholder="How was this resolved?"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleResolve}
                  disabled={resolving || !resolveStatusId}
                >
                  {resolving ? "Resolving..." : "Resolve"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowResolve(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Show resolution info if resolved */}
      {caseData.resolvedAt && (
        <div className="bg-green-50 rounded-lg border border-green-200 p-4">
          <p className="text-sm text-green-800">
            <span className="font-medium">Resolved</span> on{" "}
            {format(new Date(caseData.resolvedAt), "MMM d, yyyy h:mm a")}
          </p>
          {caseData.resolutionNotes && (
            <p className="text-sm text-green-700 mt-1">{caseData.resolutionNotes}</p>
          )}
        </div>
      )}

      {/* Order/PO Link Modal */}
      <Dialog
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        className="relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-black/50 duration-300 ease-out data-closed:opacity-0"
        />
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <DialogPanel
              transition
              className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left shadow-xl font-serif duration-300 ease-out data-closed:scale-95 data-closed:opacity-0"
            >
              <DialogTitle as="h3" className="text-xl font-semibold text-sh-blue mb-4">
                {linkModalType === "order" ? "Link to Sales Order" : "Link to Purchase Order"}
              </DialogTitle>

              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  placeholder={
                    linkModalType === "order"
                      ? "Search by order number or customer..."
                      : "Search by PO number..."
                  }
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLinkSearch();
                  }}
                  className="flex-1 border border-sh-gray/30 rounded px-3 py-2 text-sm"
                  autoFocus
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleLinkSearch}
                  disabled={linkSearching || !linkSearch.trim()}
                >
                  {linkSearching ? "..." : "Search"}
                </Button>
              </div>

              {linkResults.length > 0 && (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {linkModalType === "order"
                    ? (linkResults as OrderSearchResult[]).map((order) => (
                        <button
                          key={order.id}
                          onClick={() => handleSelectLink(order.id)}
                          className="w-full text-left px-3 py-3 rounded hover:bg-sh-stripe text-sm min-h-[44px] flex items-center justify-between"
                        >
                          <span className="font-medium text-sh-blue">#{order.orderno}</span>
                          {order.customerName && (
                            <span className="text-sh-gray">{order.customerName}</span>
                          )}
                        </button>
                      ))
                    : (linkResults as POSearchResult[]).map((po) => (
                        <button
                          key={po.id}
                          onClick={() => handleSelectLink(po.id)}
                          className="w-full text-left px-3 py-3 rounded hover:bg-sh-stripe text-sm min-h-[44px] flex items-center justify-between"
                        >
                          <span className="font-medium text-sh-blue">#{po.poNumber}</span>
                          {po.vendorName && <span className="text-sh-gray">{po.vendorName}</span>}
                        </button>
                      ))}
                </div>
              )}

              {linkResults.length === 0 && linkSearch && !linkSearching && (
                <p className="text-sm text-sh-gray py-4 text-center">
                  No results. Try a different search term.
                </p>
              )}

              <div className="mt-4 flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setLinkModalOpen(false)}>
                  Cancel
                </Button>
              </div>
            </DialogPanel>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
