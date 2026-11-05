// /app/src/components/pipeline/QuoteClientPanel.tsx
//
// The client side of a pipeline card: how to reach them, what they have bought,
// and what the salesperson keeps on file.

import { Calendar, ClipboardList } from "lucide-react";
import { ClientActionChip, ClientContactChips } from "@/components/pipeline/ClientActionChip";
import { ClientInfoSummary } from "@/components/pipeline/ClientInfoSummary";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { hasClientInfo } from "@/lib/clientProfile";
import { parseLocalDate } from "@/lib/dateUtils";
import { hasPurchased, type PipelineClientHistory } from "@/lib/pipelineClient";
import type { PipelineQuote } from "@/pages/api/sales/pipeline/index";

function monthYear(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function ClientHistoryLine({ history }: Readonly<{ history: PipelineClientHistory }>) {
  const money = useMoneyFormatter();
  const { lastPurchase, orderCount, lifetimeSpend, brands, locations } = history;
  const orderWord = orderCount === 1 ? "order" : "orders";
  return (
    <div className="text-xs text-brand-gray space-y-1">
      {hasPurchased(history) ? (
        <p>
          <span className="font-semibold text-brand-black">Past client</span>
          {orderCount > 0 &&
            ` · ${orderCount} ${orderWord} · ${money(lifetimeSpend, { whole: true })} lifetime`}
          {lastPurchase?.orderDate && ` · last order ${monthYear(lastPurchase.orderDate)}`}
          {lastPurchase && lastPurchase.items.length > 0 && `: ${lastPurchase.items.join(", ")}`}
        </p>
      ) : (
        <p>New client, nothing purchased yet</p>
      )}
      {brands.length > 0 && <p>Brands bought: {brands.join(", ")}</p>}
      {locations.length > 0 && <p>Addresses on file: {locations.join(" · ")}</p>}
    </div>
  );
}

function nextFollowUpLabel(date: string | null): string {
  if (!date) return "Set next follow-up";
  const label = parseLocalDate(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `Follow up ${label}`;
}

export function QuoteClientPanel({
  quote,
  onClientInfo,
}: Readonly<{
  quote: PipelineQuote;
  onClientInfo: (quote: PipelineQuote) => void;
}>) {
  const { customer } = quote;
  if (!customer || customer.isCashSale) return null;

  const { phone, email, profile, history } = customer;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <ClientContactChips customerId={customer.id} phone={phone} email={email} />
        <ClientActionChip
          icon={<ClipboardList className="w-3.5 h-3.5" />}
          emphasis={!hasClientInfo(profile)}
          onClick={() => onClientInfo(quote)}
        >
          {hasClientInfo(profile) ? "Edit client info" : "Add client info"}
        </ClientActionChip>
        <ClientActionChip
          icon={<Calendar className="w-3.5 h-3.5" />}
          onClick={() => onClientInfo(quote)}
        >
          {nextFollowUpLabel(profile?.nextFollowUpDate ?? null)}
        </ClientActionChip>
      </div>
      {history && <ClientHistoryLine history={history} />}
      {profile && hasClientInfo(profile) && <ClientInfoSummary profile={profile} />}
    </div>
  );
}
