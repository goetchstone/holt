// /app/src/components/dashboard/UpBoard.tsx
//
// Up-board component for a single store.
// Shows the designer rotation: who is UP, WITH_CUSTOMER, ON_BREAK, or AVAILABLE.
// Styled per the app brand guide: clean, serif type, muted palette.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

type StaffInfo = {
  id: number;
  displayName: string;
  role: string;
};

type BoardEntry = {
  id: number;
  staffMemberId: number;
  storeLocation: string;
  position: number;
  status: "UP" | "WITH_CUSTOMER" | "ON_BREAK" | "AVAILABLE";
  statusSince: string;
  customerNote: string | null;
  staffMember: StaffInfo;
};

type UpBoardProps = {
  store: string;
  storeLabel: string;
};

const STATUS_CONFIG: Record<
  string,
  { bg: string; border: string; text: string; badge: string; label: string }
> = {
  UP: {
    bg: "bg-white",
    border: "border-sh-blue",
    text: "text-sh-blue",
    badge: "bg-sh-blue text-white",
    label: "Up Next",
  },
  WITH_CUSTOMER: {
    bg: "bg-sh-linen",
    border: "border-sh-gold",
    text: "text-sh-blue",
    badge: "bg-sh-gold/20 text-sh-gold",
    label: "With Client",
  },
  ON_BREAK: {
    bg: "bg-gray-50",
    border: "border-sh-gray/40",
    text: "text-sh-gray",
    badge: "bg-sh-gray/10 text-sh-gray",
    label: "On Break",
  },
  AVAILABLE: {
    bg: "bg-white",
    border: "border-gray-200",
    text: "text-sh-black",
    badge: "bg-gray-100 text-sh-gray",
    label: "Available",
  },
};

export default function UpBoard({ store, storeLabel }: UpBoardProps) {
  const router = useRouter();
  const [entries, setEntries] = useState<BoardEntry[]>([]);
  const [allStaff, setAllStaff] = useState<StaffInfo[]>([]);
  const [showClockIn, setShowClockIn] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch(`/api/upboard/${encodeURIComponent(store)}`);
      if (res.ok) setEntries(await res.json());
    } catch {
      // ignore: board re-polls every 15s, transient fetch failures self-heal
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    fetchBoard();
    const interval = setInterval(fetchBoard, 15000);
    return () => clearInterval(interval);
  }, [fetchBoard]);

  const fetchStaff = async () => {
    const res = await fetch("/api/staff");
    if (res.ok) setAllStaff(await res.json());
  };

  const clockIn = async (staffMemberId: number) => {
    await fetch("/api/upboard/clock-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffMemberId, storeLocation: store }),
    });
    setShowClockIn(false);
    fetchBoard();
  };

  const doAction = async (staffMemberId: number, action: string) => {
    const res = await fetch("/api/upboard/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffMemberId, action }),
    });
    if (res.ok) {
      const data = await res.json();
      setEntries(data.board);
      if (data.interactionId) {
        router.push(`/app/interactions/${data.interactionId}`);
      }
    }
  };

  const clockOut = async (staffMemberId: number) => {
    await fetch("/api/upboard/clock-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staffMemberId }),
    });
    fetchBoard();
  };

  const onBoardIds = new Set(entries.map((e) => e.staffMemberId));
  const availableToClockIn = allStaff.filter((s) => !onBoardIds.has(s.id));

  const upPerson = entries.find((e) => e.status === "UP");
  const withCustomer = entries.filter((e) => e.status === "WITH_CUSTOMER");
  const available = entries.filter((e) => e.status === "AVAILABLE");
  const onBreak = entries.filter((e) => e.status === "ON_BREAK");

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-sm p-6">
        <h3 className="font-serif-display text-sh-blue text-lg tracking-wide mb-3">{storeLabel}</h3>
        <div className="text-sh-gray text-sm italic">Loading&hellip;</div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-100">
        <h3 className="font-serif-display text-sh-blue text-lg tracking-wide">{storeLabel}</h3>
        <button
          onClick={() => {
            fetchStaff();
            setShowClockIn(!showClockIn);
          }}
          className="text-sm font-serif-condensed font-semibold tracking-wide px-4 py-2 rounded-lg border border-sh-blue text-sh-blue hover:bg-sh-blue hover:text-white transition shadow-sm"
        >
          Sign In
        </button>
      </div>

      {/* Clock-in panel */}
      {showClockIn && (
        <div className="mb-4 border border-gray-100 bg-sh-linen p-3 max-h-52 overflow-y-auto">
          {availableToClockIn.length === 0 ? (
            <div className="text-xs text-sh-gray italic py-2 text-center">
              All designers are signed in
            </div>
          ) : (
            <div className="space-y-0.5">
              {availableToClockIn.map((s) => (
                <button
                  key={s.id}
                  onClick={() => clockIn(s.id)}
                  className="block w-full text-left px-3 py-2 text-sm font-serif text-sh-blue hover:bg-white transition-colors rounded-sm"
                >
                  {s.displayName}
                  <span className="text-xs text-sh-gray ml-2 font-sans uppercase tracking-wider">
                    {s.role}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Board entries */}
      {entries.length === 0 ? (
        <div className="text-sh-gray text-sm italic py-8 text-center">No one signed in</div>
      ) : (
        <div className="space-y-2">
          {upPerson && <EntryRow entry={upPerson} onAction={doAction} onClockOut={clockOut} isUp />}
          {withCustomer.map((e) => (
            <EntryRow key={e.id} entry={e} onAction={doAction} onClockOut={clockOut} />
          ))}
          {available.map((e) => (
            <EntryRow key={e.id} entry={e} onAction={doAction} onClockOut={clockOut} />
          ))}
          {onBreak.map((e) => (
            <EntryRow key={e.id} entry={e} onAction={doAction} onClockOut={clockOut} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  onAction,
  onClockOut,
  isUp,
}: {
  entry: BoardEntry;
  onAction: (id: number, action: string) => void;
  onClockOut: (id: number) => void;
  isUp?: boolean;
}) {
  const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.AVAILABLE;

  return (
    <div
      className={`px-4 py-2.5 border ${cfg.border} ${cfg.bg} ${
        isUp ? "border-l-4 shadow-sm" : "border-l-2"
      } transition-all`}
    >
      {/* Top row: name + badge */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`font-serif text-sm ${cfg.text}`}>{entry.staffMember.displayName}</span>
        <span
          className={`text-[10px] font-sans uppercase tracking-widest px-2 py-0.5 rounded-sm ${cfg.badge}`}
        >
          {cfg.label}
        </span>
        {entry.customerNote && (
          <span className="text-xs text-sh-gray italic ml-1">&mdash; {entry.customerNote}</span>
        )}
      </div>

      {/* Bottom row: action buttons */}
      <div className="flex flex-wrap gap-1.5">
        {entry.status === "UP" && (
          <ActionBtn
            label="Take Client"
            onClick={() => onAction(entry.staffMemberId, "take_customer")}
          />
        )}
        {entry.status === "WITH_CUSTOMER" && (
          <ActionBtn
            label="Done"
            onClick={() => onAction(entry.staffMemberId, "finish_customer")}
          />
        )}
        {entry.status === "ON_BREAK" && (
          <ActionBtn
            label="Return"
            onClick={() => onAction(entry.staffMemberId, "return_from_break")}
          />
        )}
        {(entry.status === "UP" || entry.status === "AVAILABLE") && (
          <ActionBtn
            label="Break"
            onClick={() => onAction(entry.staffMemberId, "go_on_break")}
            variant="muted"
          />
        )}
        <ActionBtn
          label="Sign Out"
          onClick={() => onClockOut(entry.staffMemberId)}
          variant="muted"
        />
      </div>
    </div>
  );
}

function ActionBtn({
  label,
  onClick,
  variant = "primary",
}: {
  label: string;
  onClick: () => void;
  variant?: "primary" | "muted";
}) {
  const styles = {
    primary: "bg-sh-blue text-white hover:bg-sh-black shadow-md",
    muted: "bg-white text-sh-blue border border-sh-blue hover:bg-sh-gray/10",
  };

  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-serif-condensed font-semibold tracking-wide px-3 py-1.5 rounded-lg transition shadow-sm ${styles[variant]}`}
    >
      {label}
    </button>
  );
}
