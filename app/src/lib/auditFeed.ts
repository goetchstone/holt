// /app/src/lib/auditFeed.ts
//
// One list of who did what (GAP-29, DECISIONS 50). AuditEntry holds what had no
// history of its own, and the other histories stay where they are (rule 6), so this
// reads each newest first and merges them. Paging asks each source for everything up
// to the end of the page, which stays cheap because each one reads by an indexed date.

import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/formatMoney";
import { businessDayRange } from "@/lib/reports/businessDay";
import { orderChangeLabel } from "@/lib/sales/orderChangeLabels";
import {
  AUDIT_EVENTS,
  AUDIT_GROUPS,
  auditEventsIn,
  isAuditEvent,
  isAuditGroup,
  type AuditGroup,
} from "@/lib/auditCatalog";

export const AUDIT_PAGE_SIZE = 50;

export interface AuditFilter {
  /** Part of the person's email, any case. */
  who: string;
  group: AuditGroup | null;
  /** Calendar days in the store's time, as typed. */
  fromDay: string;
  toDay: string;
  page: number;
}

export interface AuditRow {
  key: string;
  when: Date;
  /** Null when the history didn't record anyone: never guessed. */
  who: string | null;
  group: AuditGroup;
  what: string;
  summary: string;
  href: string | null;
}

export interface AuditFeed {
  rows: AuditRow[];
  hasMore: boolean;
}

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function dayFrom(value: string | string[] | undefined): string {
  const day = first(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : "";
}

/** A URL's filter. Whatever can't be read is left out rather than refused. */
export function auditFilterFrom(params: Params): AuditFilter {
  const group = first(params.group);
  const page = Number.parseInt(first(params.page), 10);
  return {
    who: first(params.who),
    group: isAuditGroup(group) ? group : null,
    fromDay: dayFrom(params.from),
    toDay: dayFrom(params.to),
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** Where an entry's target can be opened. */
export function auditTargetHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === "order") return `/app/sales/orders/${id}`;
  if (type === "customer") return `/app/sales/customers/${id}`;
  if (type === "product") return `/app/inventory/products/${id}`;
  if (type === "staff") return "/app/admin/staff";
  if (type === "role") return "/app/admin/setup/roles";
  return null;
}

interface Scope {
  created?: { gte?: Date; lt?: Date };
  who?: { contains: string; mode: "insensitive" };
  take: number;
  group: AuditGroup | null;
  money: (value: unknown) => string;
}

interface Source {
  /** Skipped when the filter asks for another group. */
  groups: AuditGroup[];
  read(scope: Scope): Promise<AuditRow[]>;
}

const SOURCES: Source[] = [
  {
    groups: Object.keys(AUDIT_GROUPS) as AuditGroup[],
    async read({ created, who, take, group }) {
      const entries = await prisma.auditEntry.findMany({
        where: {
          created,
          actor: who,
          ...(group ? { event: { in: auditEventsIn(group) } } : {}),
        },
        orderBy: { created: "desc" },
        take,
      });
      return entries.map((entry) => {
        const info = isAuditEvent(entry.event) ? AUDIT_EVENTS[entry.event] : null;
        return {
          key: `audit-${entry.id}`,
          when: entry.created,
          who: entry.actor,
          group: info?.group ?? "data",
          what: info?.label ?? entry.event,
          summary: entry.summary,
          href: auditTargetHref(entry.targetType, entry.targetId),
        };
      });
    },
  },
  {
    groups: ["sales"],
    async read({ created, who, take }) {
      const changes = await prisma.orderChangeLog.findMany({
        where: { created, changedBy: who },
        orderBy: { created: "desc" },
        take,
        include: { salesOrder: { select: { orderno: true } } },
      });
      return changes.map((change) => {
        const moved = [change.previousValue, change.newValue].filter(Boolean).join(" → ");
        const detail = [moved, change.reason].filter(Boolean).join(". ");
        return {
          key: `order-${change.id}`,
          when: change.created,
          who: change.changedBy,
          group: "sales",
          what: orderChangeLabel(change.changeType),
          summary: [change.salesOrder.orderno, detail].filter(Boolean).join(": "),
          href: auditTargetHref("order", String(change.salesOrderId)),
        };
      });
    },
  },
  {
    groups: ["sales"],
    async read({ created, who, take, money }) {
      // By id, not barcode: a card's barcode spends it, and this list is read on a screen.
      const moves = await prisma.giftCardTransaction.findMany({
        where: { created, createdBy: who },
        orderBy: { created: "desc" },
        take,
      });
      return moves.map((move) => ({
        key: `gift-card-${move.id}`,
        when: move.created,
        who: move.createdBy,
        group: "sales",
        what: "Gift card",
        summary: `Card ${move.giftCardId}: ${move.transactionType.toLowerCase()} ${money(move.amount)}, balance ${money(move.balanceAfter)}`,
        href: `/app/admin/gift-cards/${move.giftCardId}`,
      }));
    },
  },
  {
    groups: ["sales"],
    async read({ created, who, take, money }) {
      const moves = await prisma.customerCreditTransaction.findMany({
        where: { created, createdBy: who },
        orderBy: { created: "desc" },
        take,
      });
      return moves.map((move) => ({
        key: `credit-${move.id}`,
        when: move.created,
        who: move.createdBy,
        group: "sales",
        what: "Store credit",
        summary: `${move.type.toLowerCase()} ${money(move.amount)}, balance ${money(move.balanceAfter)}`,
        href: auditTargetHref("customer", String(move.customerId)),
      }));
    },
  },
  {
    groups: ["books"],
    async read({ created, who, take }) {
      const edits = await prisma.commissionPayoutEdit.findMany({
        where: { editedAt: created, editedBy: who },
        orderBy: { editedAt: "desc" },
        take,
      });
      return edits.map((edit) => ({
        key: `payout-${edit.id}`,
        when: edit.editedAt,
        who: edit.editedBy,
        group: "books",
        what: "Commission payout edited",
        summary: `${edit.fieldChanged}: ${JSON.stringify(edit.oldValue)} → ${JSON.stringify(edit.newValue)}. ${edit.reason}`,
        href: null,
      }));
    },
  },
  {
    groups: ["stock"],
    async read({ created, who, take }) {
      // Only a person's: an email. Holt moves stock by itself all day, committing it to
      // orders and so on, under no name or a job's, and that would bury everything else.
      const moves = await prisma.stockMovement.findMany({
        where: {
          occurredAt: created,
          AND: [{ actor: { contains: "@" } }, ...(who ? [{ actor: who }] : [])],
        },
        orderBy: { occurredAt: "desc" },
        take,
        include: { product: { select: { name: true } } },
      });
      return moves.map((move) => ({
        key: `stock-${move.id}`,
        when: move.occurredAt,
        who: move.actor,
        group: "stock",
        what: "Stock moved",
        summary: `${move.product.name}: ${Number(move.quantity)}, ${move.reason}`,
        href: auditTargetHref("product", String(move.productId)),
      }));
    },
  },
  {
    groups: ["settings"],
    async read({ created, who, take }) {
      const applied = await prisma.configChangeLog.findMany({
        where: { created, actor: who },
        orderBy: { created: "desc" },
        take,
      });
      return applied.map((change) => ({
        key: `config-${change.id}`,
        when: change.created,
        who: change.actor,
        group: "settings",
        what: "Configuration applied",
        summary: `${change.presetKind} ${change.presetName}: ${change.action}`,
        href: null,
      }));
    },
  },
];

function range(filter: AuditFilter, timeZone: string): Scope["created"] {
  if (!filter.fromDay && !filter.toDay) return undefined;
  return {
    ...(filter.fromDay ? { gte: businessDayRange(filter.fromDay, timeZone).gte } : {}),
    ...(filter.toDay ? { lt: businessDayRange(filter.toDay, timeZone).lt } : {}),
  };
}

export async function loadAuditFeed(
  filter: AuditFilter,
  store: { timezone: string; locale: string; currency: string },
): Promise<AuditFeed> {
  const end = filter.page * AUDIT_PAGE_SIZE;
  const scope: Scope = {
    created: range(filter, store.timezone),
    who: filter.who ? { contains: filter.who, mode: "insensitive" } : undefined,
    // One past the end, to know whether there's more.
    take: end + 1,
    group: filter.group,
    money: (value) =>
      formatMoney(Number(value), { locale: store.locale, currency: store.currency }),
  };
  const asked = SOURCES.filter((s) => !filter.group || s.groups.includes(filter.group));
  const merged = (await Promise.all(asked.map((s) => s.read(scope))))
    .flat()
    .sort((a, b) => b.when.getTime() - a.when.getTime() || a.key.localeCompare(b.key));
  return {
    rows: merged.slice(end - AUDIT_PAGE_SIZE, end),
    hasMore: merged.length > end,
  };
}
