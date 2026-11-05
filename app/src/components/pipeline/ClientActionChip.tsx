// /app/src/components/pipeline/ClientActionChip.tsx
//
// Touch-sized client actions shared by the pipeline card and the client book. A
// pipeline card is a link, so every chip calls preventDefault and stopPropagation
// to keep from navigating to the quote.

import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/router";
import { Mail, Phone, UserRound } from "lucide-react";

export function ClientActionChip({
  onClick,
  icon,
  children,
  emphasis = false,
}: Readonly<{
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
  emphasis?: boolean;
}>) {
  const color = emphasis
    ? "border-brand-gold/60 text-brand-black hover:bg-brand-linen"
    : "border-brand-gray/30 text-brand-gray hover:bg-brand-linen";

  function handleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1.5 max-w-[260px] rounded-lg border px-3 min-h-[44px] text-xs transition-colors ${color}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

export function ClientContactChips({
  customerId,
  phone,
  email,
}: Readonly<{ customerId: number; phone: string | null; email: string | null }>) {
  const router = useRouter();
  return (
    <>
      {phone && (
        <ClientActionChip
          icon={<Phone className="w-3.5 h-3.5" />}
          onClick={() => {
            globalThis.location.href = `tel:${phone.replaceAll(/\D/g, "")}`;
          }}
        >
          {phone}
        </ClientActionChip>
      )}
      {email && (
        <ClientActionChip
          icon={<Mail className="w-3.5 h-3.5" />}
          onClick={() => {
            globalThis.location.href = `mailto:${email}`;
          }}
        >
          {email}
        </ClientActionChip>
      )}
      <ClientActionChip
        icon={<UserRound className="w-3.5 h-3.5" />}
        onClick={() => router.push(`/app/sales/customers/${customerId}?tab=notes`)}
      >
        Client profile
      </ClientActionChip>
    </>
  );
}
