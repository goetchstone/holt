"use client";

// GAP-06: a manager approves a discount at the register with their PIN.
//
// `send(request)` runs a request. When the server answers that the discount
// needs a manager (lib/sales/discountApproval.ts), it asks for one here (their
// name and PIN) and sends the request again with the approval. A wrong PIN is
// shown and asked again; Cancel resolves null and nothing is written. The
// server decides every time: this only collects what it asked for.
//
// Used by every screen that can sell below list: the register, New Quote, the
// order screen's line edits, and the delivery fee.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import Modal from "@/components/ui/Modal";
import {
  type ApprovalRequiredBody,
  type DiscountApproval,
  type DiscountApprover,
  isApprovalRequired,
} from "@/lib/sales/discountPolicyShared";

interface Pending {
  asked: ApprovalRequiredBody;
  /** Why the last approval was refused (a wrong PIN, a lock), if it was. */
  refused: string | null;
  /** The manager chosen last time, kept for another try at the PIN. */
  lastApproverId: number | null;
  resolve: (approval: DiscountApproval | null) => void;
}

/** The server's answer to an approval it refused: a wrong PIN, a locked PIN. */
function approvalRefusal(err: unknown): string | null {
  if (!axios.isAxiosError(err) || !err.response) return null;
  const { status, data } = err.response;
  if (status !== 400 && status !== 403 && status !== 423) return null;
  const message = (data as { error?: unknown } | undefined)?.error;
  return typeof message === "string" ? message : null;
}

/** What to ask a manager after a failed send, or null when it isn't about approval. */
function askAfter(
  err: unknown,
  sentApproval: boolean,
  lastAsked: ApprovalRequiredBody | null,
): { asked: ApprovalRequiredBody; refused: string | null } | null {
  const body = axios.isAxiosError(err) ? err.response?.data : undefined;
  if (isApprovalRequired(body)) return { asked: body, refused: null };
  const refused = sentApproval ? approvalRefusal(err) : null;
  return lastAsked && refused ? { asked: lastAsked, refused } : null;
}

export function useDiscountApproval() {
  const [pending, setPending] = useState<Pending | null>(null);

  const send = useCallback(
    async <T,>(request: (approval?: DiscountApproval) => Promise<T>): Promise<T | null> => {
      let approval: DiscountApproval | undefined;
      let asked: ApprovalRequiredBody | null = null;
      for (;;) {
        try {
          return await request(approval);
        } catch (err) {
          const ask = askAfter(err, approval != null, asked);
          if (!ask) throw err;
          asked = ask.asked;
          const next = await new Promise<DiscountApproval | null>((resolve) =>
            setPending({ ...ask, lastApproverId: approval?.approverId ?? null, resolve }),
          );
          setPending(null);
          if (!next) return null;
          approval = next;
        }
      }
    },
    [],
  );

  const modal = pending ? (
    <ManagerApprovalModal
      asked={pending.asked}
      refused={pending.refused}
      lastApproverId={pending.lastApproverId}
      onApprove={(approval) => pending.resolve(approval)}
      onCancel={() => pending.resolve(null)}
    />
  ) : null;

  return { send, modal };
}

function ManagerApprovalModal({
  asked,
  refused,
  lastApproverId,
  onApprove,
  onCancel,
}: Readonly<{
  asked: ApprovalRequiredBody;
  refused: string | null;
  lastApproverId: number | null;
  onApprove: (approval: DiscountApproval) => void;
  onCancel: () => void;
}>) {
  const [approvers, setApprovers] = useState<DiscountApprover[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [approverId, setApproverId] = useState(
    lastApproverId == null ? "" : String(lastApproverId),
  );
  const [pin, setPin] = useState("");

  useEffect(() => {
    let cancelled = false;
    axios
      .get<DiscountApprover[]>("/api/sales/discount-approvers")
      .then((res) => {
        if (!cancelled) setApprovers(res.data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = approverId !== "" && /^\d{4,8}$/.test(pin);
  const approve = () => {
    if (ready) onApprove({ approverId: Number(approverId), pin });
  };

  return (
    <Modal title="Manager approval" onClose={onCancel} onSave={approve} saveLabel="Approve">
      <p className="text-sm text-brand-gray">
        This takes {asked.percent}% off a line. Staff may give up to {asked.limit}% on their own;
        above that a manager approves.
      </p>
      {refused && <p className="text-sm text-red-600">{refused}</p>}
      {loadFailed && (
        <p className="text-sm text-red-600">Couldn&apos;t load the managers who can approve.</p>
      )}
      {approvers?.length === 0 && (
        <p className="text-sm text-amber-700">
          No manager has set a register PIN yet. A manager sets one on My Account.
        </p>
      )}
      <div>
        <label htmlFor="approval-manager" className="mb-1 block text-sm text-brand-gray">
          Manager
        </label>
        <select
          id="approval-manager"
          value={approverId}
          onChange={(e) => setApproverId(e.target.value)}
          className="w-full rounded border border-brand-gray/30 px-2 py-2 text-sm"
        >
          <option value="">Choose the manager</option>
          {(approvers ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="approval-pin" className="mb-1 block text-sm text-brand-gray">
          PIN
        </label>
        <input
          id="approval-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") approve();
          }}
          className="w-40 rounded border border-brand-gray/30 px-2 py-2 text-sm"
        />
      </div>
    </Modal>
  );
}
