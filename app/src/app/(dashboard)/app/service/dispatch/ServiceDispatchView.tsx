"use client";

// /app/src/app/(dashboard)/app/service/dispatch/ServiceDispatchView.tsx
//
// Service dispatch board (pending / scheduled / history tabs, schedule + status
// actions). App Router port of the legacy pages/service/dispatch.tsx body (minus
// MainLayout chrome, which comes from the (dashboard) layout). Reads the shared
// /api/service/dispatch + installers REST endpoints.

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";

type Tab = "pending" | "scheduled" | "history";

interface Installer {
  id: number;
  name: string;
}

interface Appointment {
  id: number;
  appointmentNumber: string;
  type: string;
  customerName: string;
  orderNumber: string | null;
  department: string | null;
  urgency: string | null;
  created: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  installerId: number | null;
  installerName: string | null;
  status: string;
  address: string | null;
  city: string | null;
  state: string | null;
  completedDate: string | null;
}

const TYPE_STYLES: Record<string, string> = {
  MEASURE: "bg-blue-100 text-blue-800",
  INSTALL: "bg-yellow-100 text-yellow-800",
  DELIVERY: "bg-green-100 text-green-800",
};

const TYPE_LABELS: Record<string, string> = {
  MEASURE: "Measure",
  INSTALL: "Install",
  DELIVERY: "Delivery",
};

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-sh-gray/20 text-sh-gray",
  SCHEDULED: "bg-blue-100 text-blue-800",
  IN_PROGRESS: "bg-orange-100 text-orange-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

interface ScheduleForm {
  date: string;
  time: string;
  installerId: string;
}

export function ServiceDispatchView() {
  const [tab, setTab] = useState<Tab>("pending");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [appointments, setAppointments] = useState<Record<Tab, Appointment[]>>({
    pending: [],
    scheduled: [],
    history: [],
  });
  const [loading, setLoading] = useState(true);
  const [installers, setInstallers] = useState<Installer[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleForm>({
    date: "",
    time: "",
    installerId: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [pendingRes, scheduledRes, historyRes] = await Promise.all([
        axios.get("/api/service/dispatch?status=PENDING"),
        axios.get("/api/service/dispatch?status=SCHEDULED,IN_PROGRESS"),
        axios.get("/api/service/dispatch?status=COMPLETED,CANCELLED"),
      ]);
      setAppointments({
        pending: pendingRes.data.appointments || [],
        scheduled: scheduledRes.data.appointments || [],
        history: historyRes.data.appointments || [],
      });
    } catch {
      setAppointments({ pending: [], scheduled: [], history: [] });
    } finally {
      setLoading(false);
    }
  };

  const loadInstallers = async () => {
    try {
      const res = await axios.get("/api/service/installers?active=true");
      setInstallers(res.data.installers || []);
    } catch {
      setInstallers([]);
    }
  };

  useEffect(() => {
    loadData();
    loadInstallers();
  }, []);

  const handleSchedule = async (id: number) => {
    if (!scheduleForm.date || !scheduleForm.time || !scheduleForm.installerId) {
      toast.error("Date, time, and installer are required");
      return;
    }
    setSubmitting(true);
    try {
      await axios.put(`/api/service/dispatch/${id}`, {
        scheduledDate: scheduleForm.date,
        scheduledTime: scheduleForm.time,
        installerId: Number.parseInt(scheduleForm.installerId),
      });
      await axios.put(`/api/service/dispatch/${id}/status`, {
        status: "SCHEDULED",
      });
      toast.success("Appointment scheduled");
      setExpandedId(null);
      setScheduleForm({ date: "", time: "", installerId: "" });
      await loadData();
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "Failed to schedule appointment";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (id: number, status: string) => {
    setSubmitting(true);
    try {
      await axios.put(`/api/service/dispatch/${id}/status`, { status });
      toast.success(`Updated to ${STATUS_LABELS[status] || status}`);
      await loadData();
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "Failed to update status";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const filterByType = (items: Appointment[]) => {
    if (typeFilter === "ALL") return items;
    return items.filter((a) => a.type === typeFilter);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "pending", label: "Pending" },
    { key: "scheduled", label: "Scheduled" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="py-2 space-y-4 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">Service Dispatch</h1>
        <select
          className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[160px]"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="ALL">All Types</option>
          <option value="MEASURE">Measure</option>
          <option value="INSTALL">Install</option>
          <option value="DELIVERY">Delivery</option>
        </select>
      </div>

      <div className="flex gap-1 border-b border-sh-gray/20">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              tab === t.key
                ? "border-sh-blue text-sh-blue"
                : "border-transparent text-sh-gray hover:text-sh-black"
            }`}
          >
            {t.label} ({filterByType(appointments[t.key]).length})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : tab === "pending" ? (
        <PendingTable
          appointments={filterByType(appointments.pending)}
          installers={installers}
          expandedId={expandedId}
          scheduleForm={scheduleForm}
          submitting={submitting}
          onToggleExpand={(id) => {
            if (expandedId === id) {
              setExpandedId(null);
              setScheduleForm({ date: "", time: "", installerId: "" });
            } else {
              setExpandedId(id);
              setScheduleForm({ date: "", time: "", installerId: "" });
            }
          }}
          onFormChange={setScheduleForm}
          onSchedule={handleSchedule}
        />
      ) : tab === "scheduled" ? (
        <ScheduledTable
          appointments={filterByType(appointments.scheduled)}
          submitting={submitting}
          onStart={(id) => updateStatus(id, "IN_PROGRESS")}
          onComplete={(id) => updateStatus(id, "COMPLETED")}
        />
      ) : (
        <HistoryTable appointments={filterByType(appointments.history)} />
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${TYPE_STYLES[type] || "bg-sh-gray/20 text-sh-gray"}`}
    >
      {TYPE_LABELS[type] || type}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[status] || "bg-sh-gray/20 text-sh-gray"}`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sh-gray">
        {message}
      </td>
    </tr>
  );
}

function PendingTable({
  appointments,
  installers,
  expandedId,
  scheduleForm,
  submitting,
  onToggleExpand,
  onFormChange,
  onSchedule,
}: {
  appointments: Appointment[];
  installers: Installer[];
  expandedId: number | null;
  scheduleForm: ScheduleForm;
  submitting: boolean;
  onToggleExpand: (id: number) => void;
  onFormChange: (form: ScheduleForm) => void;
  onSchedule: (id: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-sh-gray/20 bg-sh-stripe">
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Appt #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[90px]">Type</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Order #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Department</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[90px]">Urgency</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[100px]">Created</th>
            <th className="text-right px-4 py-3 font-medium text-sh-gray w-[100px]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {appointments.length === 0 ? (
            <EmptyRow colSpan={8} message="No pending appointments" />
          ) : (
            appointments.map((a) => (
              <>
                <tr key={a.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                  <td className="px-4 py-2 text-sh-black font-medium">{a.appointmentNumber}</td>
                  <td className="px-4 py-2">
                    <TypeBadge type={a.type} />
                  </td>
                  <td className="px-4 py-2 text-sh-gray">{a.customerName}</td>
                  <td className="px-4 py-2 text-sh-gray">{a.orderNumber || "--"}</td>
                  <td className="px-4 py-2 text-sh-gray">{a.department || "--"}</td>
                  <td className="px-4 py-2 text-sh-gray text-xs">{a.urgency || "--"}</td>
                  <td className="px-4 py-2 text-sh-gray text-xs">
                    {format(new Date(a.created), "MMM d")}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant={expandedId === a.id ? "secondary" : "outline"}
                      onClick={() => onToggleExpand(a.id)}
                    >
                      {expandedId === a.id ? "Cancel" : "Schedule"}
                    </Button>
                  </td>
                </tr>
                {expandedId === a.id && (
                  <tr key={`${a.id}-form`} className="border-b border-sh-gray/10 bg-sh-linen">
                    <td colSpan={8} className="px-4 py-4">
                      <div className="flex flex-wrap items-end gap-4">
                        <div>
                          <label className="block text-xs font-medium text-sh-gray mb-1">
                            Date
                          </label>
                          <input
                            type="date"
                            className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[160px]"
                            value={scheduleForm.date}
                            onChange={(e) =>
                              onFormChange({ ...scheduleForm, date: e.target.value })
                            }
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-sh-gray mb-1">
                            Time
                          </label>
                          <input
                            type="time"
                            className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[120px]"
                            value={scheduleForm.time}
                            onChange={(e) =>
                              onFormChange({ ...scheduleForm, time: e.target.value })
                            }
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-sh-gray mb-1">
                            Installer
                          </label>
                          <select
                            className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[200px]"
                            value={scheduleForm.installerId}
                            onChange={(e) =>
                              onFormChange({ ...scheduleForm, installerId: e.target.value })
                            }
                          >
                            <option value="">Select installer...</option>
                            {installers.map((inst) => (
                              <option key={inst.id} value={inst.id}>
                                {inst.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <Button disabled={submitting} onClick={() => onSchedule(a.id)}>
                          Confirm Schedule
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ScheduledTable({
  appointments,
  submitting,
  onStart,
  onComplete,
}: {
  appointments: Appointment[];
  submitting: boolean;
  onStart: (id: number) => void;
  onComplete: (id: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-sh-gray/20 bg-sh-stripe">
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Appt #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[90px]">Type</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Address</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[130px]">Date/Time</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Installer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[110px]">Status</th>
            <th className="text-right px-4 py-3 font-medium text-sh-gray w-[160px]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {appointments.length === 0 ? (
            <EmptyRow colSpan={8} message="No scheduled appointments" />
          ) : (
            appointments.map((a) => (
              <tr key={a.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                <td className="px-4 py-2 text-sh-black font-medium">{a.appointmentNumber}</td>
                <td className="px-4 py-2">
                  <TypeBadge type={a.type} />
                </td>
                <td className="px-4 py-2 text-sh-gray">{a.customerName}</td>
                <td className="px-4 py-2 text-sh-gray text-xs">
                  {[a.city, a.state].filter(Boolean).join(", ") || "--"}
                </td>
                <td className="px-4 py-2 text-sh-gray text-xs">
                  {a.scheduledDate ? format(new Date(a.scheduledDate), "MMM d") : "--"}
                  {a.scheduledTime ? ` ${a.scheduledTime}` : ""}
                </td>
                <td className="px-4 py-2 text-sh-gray">{a.installerName || "--"}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={a.status} />
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex gap-1 justify-end">
                    {a.status === "SCHEDULED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={submitting}
                        onClick={() => onStart(a.id)}
                      >
                        Start
                      </Button>
                    )}
                    {(a.status === "SCHEDULED" || a.status === "IN_PROGRESS") && (
                      <Button size="sm" disabled={submitting} onClick={() => onComplete(a.id)}>
                        Complete
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({ appointments }: { appointments: Appointment[] }) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-sh-gray/20 bg-sh-stripe">
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Appt #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[90px]">Type</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[100px]">Date</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Installer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[110px]">Status</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[110px]">Completed</th>
          </tr>
        </thead>
        <tbody>
          {appointments.length === 0 ? (
            <EmptyRow colSpan={7} message="No history" />
          ) : (
            appointments.map((a) => (
              <tr key={a.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                <td className="px-4 py-2 text-sh-black font-medium">{a.appointmentNumber}</td>
                <td className="px-4 py-2">
                  <TypeBadge type={a.type} />
                </td>
                <td className="px-4 py-2 text-sh-gray">{a.customerName}</td>
                <td className="px-4 py-2 text-sh-gray text-xs">
                  {a.scheduledDate ? format(new Date(a.scheduledDate), "MMM d, yyyy") : "--"}
                </td>
                <td className="px-4 py-2 text-sh-gray">{a.installerName || "--"}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={a.status} />
                </td>
                <td className="px-4 py-2 text-sh-gray text-xs">
                  {a.completedDate ? format(new Date(a.completedDate), "MMM d, yyyy") : "--"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
