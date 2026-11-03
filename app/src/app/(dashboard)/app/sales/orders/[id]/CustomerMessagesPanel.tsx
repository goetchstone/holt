"use client";

// GAP-13: the automatic messages Holt sent this order's customer, on the order
// screen (GET orders/[id]/messages, lib/messages/history.ts): what went and
// where it stands, and what didn't go and why. Shows nothing until there is
// one, so a store that sends none sees no panel.

import { useEffect, useState } from "react";
import axios from "axios";
import { format } from "date-fns";
import type { OrderMessage } from "@/lib/messages/history";

function standing(m: OrderMessage): string {
  if (m.status === "SKIPPED") return `Not sent: ${m.skipReason ?? "no reason recorded."}`;
  const to = m.toAddress ? ` to ${m.toAddress}` : "";
  if (m.emailStatus === "SENT") {
    return `Sent${to}${m.sentAt ? ` ${format(new Date(m.sentAt), "PPP p")}` : ""}.`;
  }
  if (m.emailStatus === "FAILED") return `Couldn't be sent${to}. Admin › Email has the reason.`;
  return `Waiting to send${to}.`;
}

export function CustomerMessagesPanel({ orderId }: Readonly<{ orderId: number }>) {
  const [messages, setMessages] = useState<OrderMessage[]>([]);

  useEffect(() => {
    let live = true;
    axios
      .get<OrderMessage[]>(`/api/sales/orders/${encodeURIComponent(String(orderId))}/messages`)
      .then((res) => {
        if (live) setMessages(res.data);
      })
      // History only: an order page that can't load it shows none.
      .catch(() => {
        if (live) setMessages([]);
      });
    return () => {
      live = false;
    };
  }, [orderId]);

  if (messages.length === 0) return null;
  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-3">Messages to the customer</h2>
      <ul className="space-y-2 text-sm">
        {messages.map((m) => (
          <li key={m.id} className="flex flex-wrap gap-x-3">
            <span className="font-medium">{m.label}</span>
            <span className="text-brand-gray">{format(new Date(m.created), "PPP p")}</span>
            <span className={m.status === "SKIPPED" ? "text-brand-gray" : ""}>{standing(m)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
