"use client";

// /app/src/app/(dashboard)/app/sales/pos/PosView.tsx
//
// Point of Sale register body -- App Router port of the legacy pages/sales/pos.tsx
// (minus MainLayout chrome, which the (dashboard) layout supplies). Scan-to-cart,
// per-item + order discounts, return mode, order creation, and the tender +
// payment flow all read/write the shared /api/* REST endpoints exactly as before.
// Money is shown in cents (POS register precision) via useMoneyFormatter; the
// tender/change arithmetic is copied verbatim from the legacy page.

import { useState, useRef, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useActiveStore } from "@/hooks/useActiveStore";
import { NoTaxDistrictBanner } from "@/components/sales/NoTaxDistrictBanner";
import { useCustomerSearch } from "@/hooks/useCustomerSearch";
import { useProductSearch } from "@/hooks/useProductSearch";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { RetailPriceTag } from "@/components/sales/RetailPriceTag";
import { getErrorMessage } from "@/lib/toastError";
import {
  catalogRetailPrice,
  catalogSale,
  lineSale,
  noRetailPriceMessage,
  priceCart,
  type CartDiscount,
  type CatalogSale,
  type DiscountType,
} from "@/lib/pos/cartPricing";
import { REGISTER_STORAGE_KEY, cashNeedsTill, registerHas } from "@/lib/pos/registerChoice";
import {
  priceLineForTier,
  tierFieldsFromLookup,
  tradeLabel,
  type CustomerTradeTier,
} from "@/lib/pricing/tradeTier";
import { onHandByStore } from "@/lib/inventory/onHandSummary";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { REFERENCE_MAX, type OfferedTender } from "@/lib/payments/tenderShared";
import type { TestCardOutcome } from "@/lib/payments/types";
import type { OrderToPayResult } from "@/lib/sales/orderToPay";
import { deliveryPieces } from "@/lib/delivery/deliveryFeeShared";
import { DeliveryFeeField } from "./DeliveryFeeField";
import {
  SplitSaleField,
  emptySplit,
  splitBody,
  type SplitChoice,
} from "@/components/sales/SplitSaleField";
import type { SplitSaleSetup } from "@/lib/commissionSplit";
import { useDiscountApproval } from "@/components/sales/useDiscountApproval";
import {
  GIFT_CARD_LINE,
  GIFT_CARD_LINE_NAME,
  closedCardMessage,
  type GiftCardCartLine,
} from "@/lib/sales/giftCardLineShared";
import { RegisterLookup } from "./RegisterLookup";

interface Register {
  id: number;
  name: string;
  isActive: boolean;
  storeLocation: { id: number; name: string; code: string };
  /** For choosing where to take a payment (GET /api/registers). */
  hasOpenTill?: boolean;
  hasCardReader?: boolean;
}

/** The card reader at the chosen register (GET /api/registers/[id]). */
interface RegisterReader {
  label: string;
  simulated: boolean;
}

/** A card payment out on the reader, waiting for the customer's card. */
interface ReaderPayment {
  paymentId: number;
  amount: number;
  readerLabel: string;
  simulated: boolean;
  /** Why a cancel could not stop it. */
  message?: string;
}

/** How often the register asks how a reader payment went. */
const READER_POLL_MS = 2000;

interface ReaderState {
  status: string;
  amount: number;
  message?: string;
}

/**
 * The register's side of a card reader payment: whether this register has a
 * reader, the payment out on it, and asking how it went until it is settled.
 * The server decides everything (lib/payments/cardReaderPayments.ts); this
 * only starts, asks, cancels and shows.
 */
function useCardReader({
  registerId,
  orderId,
  findOpenTill,
  setBusy,
  onApproved,
}: {
  registerId: number | undefined;
  orderId: number | undefined;
  findOpenTill: () => Promise<number | undefined>;
  setBusy: (busy: boolean) => void;
  onApproved: (amount: number) => void;
}) {
  const [registerReader, setRegisterReader] = useState<RegisterReader | null>(null);
  const [readerPayment, setReaderPayment] = useState<ReaderPayment | null>(null);

  // Whether this register has a card reader decides what "Card" does: send the
  // amount to the reader, or only record a payment taken elsewhere.
  useEffect(() => {
    if (registerId === undefined) return;
    let current = true;
    axios
      .get(`/api/registers/${registerId}`)
      .then((res) => {
        if (current) setRegisterReader(res.data.cardReader ?? null);
      })
      .catch(() => {
        if (current) setRegisterReader(null);
      });
    return () => {
      current = false;
    };
  }, [registerId]);

  /** What the reader said: record it on screen, or keep waiting. */
  const applyState = (state: ReaderState) => {
    if (state.status === "WAITING") {
      if (state.message) {
        setReaderPayment((now) => (now ? { ...now, message: state.message } : now));
      }
      return;
    }
    setReaderPayment(null);
    if (state.status === "APPROVED") onApproved(state.amount);
    else if (state.status === "DECLINED") {
      toast.error(state.message ?? "The card payment didn't go through");
    } else toast.info("Card payment cancelled");
  };
  const applyStateRef = useRef(applyState);
  useEffect(() => {
    applyStateRef.current = applyState;
  });

  const paymentUrl =
    orderId !== undefined && readerPayment
      ? `/api/sales/orders/${orderId}/payments/${readerPayment.paymentId}/card-reader`
      : null;

  // While a payment is out on the reader, ask how it went every two seconds.
  // A failed ask is not a failed payment: keep asking.
  useEffect(() => {
    if (!paymentUrl) return;
    const timer = setInterval(() => {
      axios
        .get(paymentUrl)
        .then((res) => applyStateRef.current(res.data))
        .catch(() => undefined);
    }, READER_POLL_MS);
    return () => clearInterval(timer);
  }, [paymentUrl]);

  /** Send a card payment to this register's reader; the poll above finishes it. */
  const startReaderPayment = async (amount: number) => {
    if (orderId === undefined) return;
    setBusy(true);
    try {
      const tillId = await findOpenTill();
      const res = await axios.post(`/api/sales/orders/${orderId}/card-reader-payment`, {
        amount,
        registerId,
        tillId,
      });
      if (res.data.status === "APPROVED") {
        // One already out on the reader had gone through.
        onApproved(res.data.amount);
        return;
      }
      setReaderPayment({
        paymentId: res.data.paymentId,
        amount: res.data.amount,
        readerLabel: res.data.readerLabel,
        simulated: res.data.simulated,
      });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't send the payment to the card reader"));
    } finally {
      setBusy(false);
    }
  };

  const cancelReaderPayment = async () => {
    if (!paymentUrl) return;
    try {
      const res = await axios.delete(paymentUrl);
      applyState(res.data);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't cancel the card payment"));
    }
  };

  const presentTestCard = async (outcome: TestCardOutcome) => {
    if (!paymentUrl) return;
    try {
      await axios.post(paymentUrl, { outcome });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't present the test card"));
    }
  };

  return {
    registerReader,
    readerPayment,
    startReaderPayment,
    cancelReaderPayment,
    presentTestCard,
  };
}

/** What the Card tender says under the amount: no reader, ready to send, or waiting. */
function CardTenderNote({
  registerReader,
  readerPayment,
  fmt,
  onCancel,
  onPresentTestCard,
}: Readonly<{
  registerReader: RegisterReader | null;
  readerPayment: ReaderPayment | null;
  fmt: MoneyFmt;
  onCancel: () => void;
  onPresentTestCard: (outcome: TestCardOutcome) => void;
}>) {
  if (!registerReader) {
    return (
      <p className="text-sm text-brand-gray py-2">
        This register has no card reader, so the payment is only recorded here. Take the card on
        your own terminal first.
      </p>
    );
  }
  if (!readerPayment) {
    return (
      <p className="text-sm text-brand-gray py-2">
        The amount is sent to the reader &ldquo;{registerReader.label}&rdquo; for the customer to
        tap, insert or swipe their card.
      </p>
    );
  }
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-brand-blue/30 bg-brand-stripe p-4"
    >
      <p className="font-semibold text-brand-blue">
        Waiting for the card on &ldquo;{readerPayment.readerLabel}&rdquo;:{" "}
        {fmt(readerPayment.amount)}
      </p>
      {readerPayment.message && <p className="text-sm text-brand-gray">{readerPayment.message}</p>}
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={onCancel}>
          Cancel card payment
        </Button>
        {readerPayment.simulated && (
          <>
            <Button variant="secondary" onClick={() => onPresentTestCard("approve")}>
              Present a test card
            </Button>
            <Button variant="secondary" onClick={() => onPresentTestCard("decline")}>
              Present a declined card
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The tender button's words: busy, send to the reader, or record. */
function tenderButtonLabel(busy: boolean, toReader: boolean, choice: string, amount: string) {
  if (busy) return "Processing...";
  if (toReader) return `Send ${amount} to the card reader`;
  return `Record ${choice} Payment -- ${amount}`;
}

// The shared pricing vocabulary (PERCENT/AMOUNT) -- kept as an alias rather
// than a second definition so the wire format always matches what the
// server (and priceCart) expects. See cartPricing.ts.
type Discount = CartDiscount;

interface InventorySummary {
  locationName: string;
  available: number;
}

interface CartItem {
  productId: number;
  productNumber: string;
  name: string;
  /** The unit price it sells for: its retail, the customer's trade price, or a typed one. */
  price: number;
  /**
   * The unit price it was listed at -- its sale price while a scheduled sale is
   * on -- so a trade tier can come on and off (GAP-06 part C).
   */
  retail: number;
  /** Whether a customer's trade tier may discount it (the product lookup says). */
  tradeEligible: boolean;
  /** Whether `retail` is a sale price (the product lookup's onSale). */
  onSale?: boolean;
  /** Whether the store lets a tier come off a sale price (the product lookup says). */
  tradeDiscountOnSaleItems?: boolean;
  /** Someone typed the price: a customer's tier never moves it. */
  priceTyped: boolean;
  /** The trade tier's percent in `price`, or null: shown as "Trade 20%". */
  tradePercent: number | null;
  /** The scheduled sale this line was added at (catalogSale), for show only; see lineSale. */
  sale: CatalogSale | null;
  cost: number;
  quantity: number;
  discounts: Discount[];
  isReturn: boolean;
  inventorySummary: InventorySummary[];
}

/**
 * A gift card sold or reloaded on this sale: a line of its own beside the
 * products, priced as its amount and nothing else (lib/sales/giftCardLineShared.ts).
 * `reload` is for the screen only; the server decides from the number.
 */
type CardLine = GiftCardCartLine & { reload: boolean };

/** The card being added: its quick code's label, the number scanned, the amount. */
interface CardDraft {
  label: string;
  number: string;
  amount: string;
}

interface CustomerResult {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** Their trade tier while it is on (GAP-06 part C), else null. */
  tradeTier?: CustomerTradeTier | null;
}

interface FoundProduct {
  id: number;
  productNumber: string;
  name?: string | null;
  baseRetail?: number | null;
  regularRetail?: number | null;
  onSale?: boolean;
  saleEndsOn?: string | null;
  baseCost?: number | null;
  /** Whether a customer's trade tier may discount it (GAP-06 part C). */
  tradeEligible?: boolean;
  /** Whether the store lets a tier come off a sale price (GAP-06 part C). */
  tradeDiscountOnSaleItems?: boolean;
}

interface GiftCardInfo {
  id: number;
  barcode: string;
  currentBalance: number;
}

interface CreatedOrder {
  id: number;
  orderno: string;
  /**
   * How the total was reached, from the server's response to the sale just
   * rung (see the note in handleCreateOrder). Null for an order written
   * earlier and opened here to take a payment: its lines are on the order.
   */
  breakdown: {
    subtotal: number;
    orderDiscountAmount: number;
    deliveryFee: number;
    taxAmount: number;
  } | null;
  total: number;
  allowSaleWithoutPayment: boolean;
  /** It sells or reloads a gift card, so it's paid in full before it leaves the register. */
  holdsGiftCard: boolean;
}

interface PaymentSummary {
  method: string;
  amount: number;
  change?: number;
  orderno: string;
}

// "TENDER" is one of the store's own payment types (Settings -> Payment
// Types), held in `tender`; the server records it under the tender's kind.
type PaymentMethodType = "CASH" | "CHECK" | "CARD" | "GIFT_CARD" | "STORE_CREDIT" | "TENDER";
type DeliveryMethod = "TAKEN" | "PICKUP" | "DELIVERY";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const PAYMENT_METHODS = ["CASH", "CHECK", "CARD", "GIFT_CARD"] as const;

const DELIVERY_METHODS: DeliveryMethod[] = ["TAKEN", "PICKUP", "DELIVERY"];

const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
  TAKEN: "Taken",
  PICKUP: "Pickup",
  DELIVERY: "Delivery",
};

/** The method and the fields only that tender posts: a check's number, a gift
 *  card's id, a store tender's id and reference (the server records a store
 *  tender under its own kind). */
function tenderFields(
  method: PaymentMethodType,
  chosen: {
    checkNumber: string;
    giftCardInfo: GiftCardInfo | null;
    tender: OfferedTender | null;
    reference: string;
  },
): Record<string, unknown> {
  if (method === "TENDER") {
    return {
      method: chosen.tender?.kind,
      tenderId: chosen.tender?.id,
      reference: chosen.reference.trim() || undefined,
    };
  }
  if (method === "CHECK") return { method, checkNumber: chosen.checkNumber.trim() };
  if (method === "GIFT_CARD") return { method, giftCardId: chosen.giftCardInfo?.id };
  return { method };
}

/** Why store credit cannot pay `amount`, or null when it can. */
function storeCreditProblem(
  hasCustomer: boolean,
  credit: number | null,
  amount: number,
  fmt: MoneyFmt,
): string | null {
  if (!hasCustomer) return "Store credit needs the customer on the order";
  if ((credit ?? 0) < amount) {
    return `Not enough store credit: ${fmt(credit ?? 0)} available, ${fmt(amount)} required`;
  }
  return null;
}

/** The delivery fee the sale charges: what's typed, when it goes out by delivery. */
function deliveryFeeOf(method: DeliveryMethod, typed: string): number {
  if (method !== "DELIVERY") return 0;
  return Number.parseFloat(typed) || 0;
}

function onHandAt(item: CartItem, locationName: string): number {
  const here = item.inventorySummary.find((s) => s.locationName === locationName);
  return here?.available ?? 0;
}

/**
 * What the register starts with: nothing, or an order written earlier that it
 * was opened to take a payment on (or why that order can't take one).
 */
function startingPayment(payOrder: OrderToPayResult | null): {
  order: CreatedOrder | null;
  paid: number;
  customer: CustomerResult | null;
  problem: string | null;
} {
  const none = { order: null, paid: 0, customer: null, problem: null };
  if (!payOrder) return none;
  if ("problem" in payOrder) return { ...none, problem: payOrder.problem };
  const earlier = payOrder.order;
  return {
    order: {
      id: earlier.id,
      orderno: earlier.orderno,
      breakdown: null,
      total: earlier.total,
      allowSaleWithoutPayment: false,
      holdsGiftCard: earlier.holdsGiftCard,
    },
    paid: earlier.paid,
    customer: earlier.customer,
    problem: null,
  };
}

/** A customer's name as one string, or null when there is none to show. */
function fullName(customer: CustomerResult | null): string | null {
  if (!customer) return null;
  return `${customer.firstName} ${customer.lastName}`.trim() || null;
}

export function PosView({
  splitSetup,
  payOrder,
  canTakePayments,
  canFindSales,
}: Readonly<{
  splitSetup: SplitSaleSetup | null;
  /** An order sent here to take a payment on (from its page or the lookup), or why it can't be. */
  payOrder: OrderToPayResult | null;
  /** The viewer holds "Take payment": the lookup offers it on a sale that owes. */
  canTakePayments: boolean;
  /** The viewer holds "View orders": the lookup searches the orders list, which is gated on it. */
  canFindSales: boolean;
}>) {
  const router = useRouter();
  // An order written earlier opens straight on the payment screen, with what
  // has been paid toward it and its customer (for store credit).
  const [start] = useState(() => startingPayment(payOrder));
  useEffect(() => {
    if (start.problem) toast.error(start.problem);
  }, [start.problem]);
  const fmt = useMoneyFormatter();
  const scanRef = useRef<HTMLInputElement>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  // Gift cards on the sale, and the one being added (a GC quick code scanned).
  const [cardLines, setCardLines] = useState<CardLine[]>([]);
  const [cardDraft, setCardDraft] = useState<CardDraft | null>(null);
  // A sale written with a colleague (GAP-07), for those allowed to split one.
  const [split, setSplit] = useState<SplitChoice>(() => emptySplit(splitSetup));
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [returnMode, setReturnMode] = useState(false);
  const { activeStore, allStores, setActiveStore, taxDistrictConfigured } = useActiveStore();

  // Register selection
  const [selectedRegister, setSelectedRegister] = useState<Register | null>(null);
  const [allRegisters, setAllRegisters] = useState<Register[]>([]);
  const [registersLoading, setRegistersLoading] = useState(true);
  const [showRegisterSelect, setShowRegisterSelect] = useState(false);

  // Product search (text-based, separate from barcode scan)
  const {
    query: productSearch,
    setQuery: setProductSearch,
    results: productResults,
    isSearching: searchingProducts,
    clear: clearProductSearch,
  } = useProductSearch({ limit: 20 });

  // Price editing
  const [editingPriceIdx, setEditingPriceIdx] = useState<number | null>(null);
  const [editPriceValue, setEditPriceValue] = useState("");

  // Created order -- when set, the payment section is shown instead of the cart
  const [createdOrder, setCreatedOrder] = useState<CreatedOrder | null>(start.order);

  // Payment flow state
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType | null>(null);
  const [tenderedAmount, setTenderedAmount] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [giftCardBarcode, setGiftCardBarcode] = useState("");
  const [giftCardInfo, setGiftCardInfo] = useState<GiftCardInfo | null>(null);
  // The order's customer's store credit, offered as a tender when there is
  // some (lib/customerCredit.ts spends it, on their own order only). Null:
  // no customer, or not loaded.
  const [storeCredit, setStoreCredit] = useState<number | null>(null);
  const [giftCardError, setGiftCardError] = useState("");
  // The store's own payment types offered here, and the one chosen with the
  // reference its payer quotes (an approval or contract number).
  const [storeTenders, setStoreTenders] = useState<OfferedTender[]>([]);
  const [tender, setTender] = useState<OfferedTender | null>(null);
  const [reference, setReference] = useState("");
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  // Deposits and split tender. The register used to send createdOrder.total on
  // every payment, so a furniture store's NORMAL transaction -- take a deposit
  // now, the balance on delivery -- could not be rung up at all, and a customer
  // paying half on a card and half in cash needed two orders.
  //
  // recordPayment already accepted any positive amount; only the UI insisted on
  // the full total. paidSoFar tracks this session's tenders so the panel can
  // show what is left and offer it as the default.
  const [paidSoFar, setPaidSoFar] = useState(start.paid);
  const [payAmount, setPayAmount] = useState("");
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);

  // Order-level discount
  const [orderDiscount, setOrderDiscount] = useState<Discount | null>(null);
  const [showOrderDiscount, setShowOrderDiscount] = useState(false);
  const [orderDiscType, setOrderDiscType] = useState<DiscountType>("PERCENT");
  const [orderDiscValue, setOrderDiscValue] = useState("");

  // Per-item discount editing
  const [discountIdx, setDiscountIdx] = useState<number | null>(null);
  const [discType, setDiscType] = useState<DiscountType>("PERCENT");
  const [discValue, setDiscValue] = useState("");

  // Customer search
  const {
    query: customerSearch,
    setQuery: setCustomerSearch,
    results: customerResults,
    isSearching: searchingCustomer,
    clear: clearCustomerSearch,
  } = useCustomerSearch({ limit: 5 });
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(start.customer);
  // A trade customer's tier prices the cart's eligible lines (GAP-06 part C).
  const tradeTier = selectedCustomer?.tradeTier ?? null;
  // The tier as of the latest customer pick, for a line added after an await:
  // a scan or search fetches stock before it adds, and a customer picked while
  // that fetch is out must price the new line too. A closure over `tradeTier`
  // would still hold the tier from before the pick and add the line at retail.
  const tradeTierRef = useRef<CustomerTradeTier | null>(null);
  // Picking, changing or removing the customer re-prices every line no one
  // typed a price on, so taking the customer off restores retail. The server
  // still judges each price it is sent (lib/sales/discountApproval.ts).
  const chooseCustomer = (customer: CustomerResult | null) => {
    const tier = customer?.tradeTier ?? null;
    tradeTierRef.current = tier;
    setSelectedCustomer(customer);
    setCart((prev) => prev.map((item) => priceLineForTier(item, tier)));
  };
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>("TAKEN");
  // The delivery fee as typed, and whether staff typed it or it follows the
  // zone (DeliveryFeeField).
  const [deliveryFee, setDeliveryFee] = useState("");
  const [deliveryFeeEdited, setDeliveryFeeEdited] = useState(false);
  const { send: sendWithApproval, modal: approvalModal } = useDiscountApproval();
  const handleDeliveryFeeChange = useCallback((value: string, edited: boolean) => {
    setDeliveryFee(value);
    setDeliveryFeeEdited(edited);
  }, []);

  // Load all registers and restore saved selection from localStorage. `again`
  // re-reads them behind the screen that is up: a till opened or closed since
  // the page loaded changes what each register says it has.
  const loadRegisters = useCallback(async (again?: "again") => {
    if (!again) setRegistersLoading(true);
    try {
      const res = await axios.get("/api/registers", { params: { limit: 200 } });
      const registers: Register[] = (res.data.registers || []).filter((r: Register) => r.isActive);
      setAllRegisters(registers);

      const savedId = localStorage.getItem(REGISTER_STORAGE_KEY);
      if (savedId) {
        const match = registers.find((r) => r.id === Number.parseInt(savedId));
        if (match) {
          setSelectedRegister(match);
        }
      }
    } catch {
      // Read again and failed: what is on the screen stays, as it was read.
      if (!again) toast.error("Failed to load registers");
    } finally {
      setRegistersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRegisters();
  }, [loadRegisters]);

  const handleSelectRegister = (register: Register) => {
    setSelectedRegister(register);
    localStorage.setItem(REGISTER_STORAGE_KEY, String(register.id));
    setShowRegisterSelect(false);
    // Sync the store selector to match the register's store
    if (register.storeLocation?.id) {
      const storeMatch = allStores.find((s) => s.name === register.storeLocation.name);
      if (storeMatch) {
        setActiveStore(storeMatch.id);
      }
    }
  };

  const handleChangeRegister = () => {
    setShowRegisterSelect(true);
    // The choice is made on which register has a till open, as of now.
    void loadRegisters("again");
  };

  useEffect(() => {
    if (selectedRegister && !showRegisterSelect && !createdOrder) {
      scanRef.current?.focus();
    }
  }, [selectedRegister, showRegisterSelect, createdOrder]);

  // Priced through the shared module -- see cartPricing.ts. There is no tax
  // rate to price with yet: tax depends on the order's tax district and the
  // customer's exemption, both resolved server-side when the order is
  // created. So `netSubtotal` here is the discounted total BEFORE tax; the
  // tax-inclusive, tenderable total only exists once the server returns it
  // (see handleCreateOrder / CreatedOrder). Showing a client-computed tax
  // figure would duplicate tax policy in the client, which is the thing
  // that caused the original bug.
  const priced = priceCart(
    cart.map((item) => ({
      unitPrice: item.price,
      quantity: item.quantity,
      discounts: item.discounts,
      isReturn: item.isReturn,
    })),
    { orderDiscount },
  );
  const { subtotal, orderDiscountAmount, netSubtotal } = priced;
  // A gift card is its amount: no discount and no tax (create-from-cart prices it the same).
  const cardTotal = round2(cardLines.reduce((sum, line) => sum + line.amount, 0));
  const cartIsEmpty = cart.length + cardLines.length === 0;
  const cartItemCount =
    cart.reduce((sum, item) => sum + Math.abs(item.quantity), 0) + cardLines.length;
  // Every cart line is goods: a custom line becomes a product of its own.
  const deliveryPieceCount = deliveryPieces(
    cart.map((item) => ({ quantity: item.quantity, goods: true, isReturn: item.isReturn })),
  );
  const deliveryFeeAmount = deliveryFeeOf(deliveryMethod, deliveryFee);

  // Free stock per store, for informational display only. Failures are
  // silently ignored -- inventory never blocks a sale.
  const fetchInventorySummary = useCallback(
    async (productId: number): Promise<InventorySummary[]> => {
      try {
        const posRes = await axios.get("/api/warehouse/positions", {
          params: { productId, freeOnly: 1, limit: 100 },
        });
        return onHandByStore(posRes.data.positions || []);
      } catch {
        return [];
      }
    },
    [],
  );

  const addProductToCart = useCallback(
    (product: FoundProduct, price: number, inventorySummary: InventorySummary[]) => {
      // Priced inside the updater from the latest customer pick, never from
      // this callback's render: the caller may have awaited stock first.
      setCart((prev) => {
        const existingIdx = prev.findIndex(
          (item) => item.productId === product.id && item.isReturn === returnMode,
        );
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            quantity: updated[existingIdx].quantity + 1,
          };
          return updated;
        }
        return [
          ...prev,
          priceLineForTier(
            {
              productId: product.id,
              productNumber: product.productNumber,
              name: product.name || product.productNumber,
              ...tierFieldsFromLookup(product, price),
              sale: catalogSale(product),
              cost: product.baseCost ? Number(product.baseCost) : 0,
              quantity: 1,
              discounts: [],
              isReturn: returnMode,
              inventorySummary,
            },
            tradeTierRef.current,
          ),
        ];
      });
    },
    [returnMode],
  );

  // A GC quick code opens the card form with the preset's amount; a bare GC
  // with no preset of its own leaves the amount to type.
  const startCardLine = useCallback(
    async (code: string) => {
      if (returnMode) {
        toast.error("A gift card is sold, not returned: turn Return Mode off to add one.");
        return;
      }
      try {
        const res = await axios.get<{ label: string | null; amount: number | null }>(
          "/api/gift-cards/presets/resolve",
          { params: { code } },
        );
        setCardDraft({
          label: res.data.label || "Gift card",
          number: "",
          amount: res.data.amount == null ? "" : res.data.amount.toFixed(2),
        });
      } catch (err: unknown) {
        if (code === "GC" && axios.isAxiosError(err) && err.response?.status === 404) {
          setCardDraft({ label: "Gift card", number: "", amount: "" });
          return;
        }
        toast.error(getErrorMessage(err, `No gift card code "${code}"`));
      }
    },
    [returnMode],
  );

  // The card's number decides what it is: an open card is a reload, an unknown
  // number a new card, a retired one is refused (the server checks all three
  // again, and issues the card only when the sale is paid in full).
  const addCardLine = async () => {
    if (!cardDraft) return;
    const number = cardDraft.number.trim();
    const amount = Number.parseFloat(cardDraft.amount);
    if (!number) {
      toast.error("Scan or type the card's number");
      return;
    }
    if (!(amount > 0) || round2(amount) !== amount) {
      toast.error("Enter the amount to put on the card, in dollars and cents");
      return;
    }
    if (cardLines.some((line) => line.giftCardNumber === number)) {
      toast.error(`Gift card ${number} is already on this sale`);
      return;
    }
    let reload = false;
    try {
      const res = await axios.get<{ status: string; replacedById: number | null }>(
        "/api/gift-cards/lookup",
        { params: { barcode: number } },
      );
      const closed = closedCardMessage(res.data);
      if (closed) {
        toast.error(closed);
        return;
      }
      reload = true;
    } catch (err: unknown) {
      if (!(axios.isAxiosError(err) && err.response?.status === 404)) {
        toast.error(getErrorMessage(err, "Couldn't look the card up"));
        return;
      }
    }
    setCardLines((prev) => [
      ...prev,
      { type: GIFT_CARD_LINE, giftCardNumber: number, amount, reload },
    ]);
    setCardDraft(null);
    toast.success(
      `${reload ? GIFT_CARD_LINE_NAME.RELOAD : GIFT_CARD_LINE_NAME.NEW} ${number}: ${fmt(amount)}`,
    );
    scanRef.current?.focus();
  };

  const handleScan = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || scanning) return;

      // Gift card quick codes: GC = an amount typed here, GC25/GC50/etc = a
      // preset's amount (Settings, Gift Cards). The card is a line on this sale,
      // paid like the rest of it, and goes live when the sale is paid in full.
      const gcMatch = trimmed.toUpperCase().match(/^GC(\d*)$/);
      if (gcMatch) {
        setScanInput("");
        void startCardLine(trimmed.toUpperCase());
        return;
      }

      setScanning(true);
      try {
        const res = await axios.get("/api/products/find-by-identifier", {
          params: { identifier: trimmed },
        });
        const product = res.data as FoundProduct;
        const price = catalogRetailPrice(product);
        if (price === null) {
          toast.error(noRetailPriceMessage(product));
          return;
        }
        const inventorySummary = await fetchInventorySummary(product.id);
        addProductToCart(product, price, inventorySummary);
        toast.success(
          `${returnMode ? "Return" : "Added"}: ${product.name || product.productNumber}`,
        );
      } catch {
        toast.error(`Product not found: "${trimmed}"`);
      } finally {
        setScanInput("");
        setScanning(false);
        scanRef.current?.focus();
      }
    },
    [scanning, returnMode, fetchInventorySummary, addProductToCart, startCardLine],
  );

  const handleScanKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(scanInput);
    }
  };

  const updateQuantity = (idx: number, qty: number) => {
    if (qty <= 0) {
      setCart(cart.filter((_, i) => i !== idx));
    } else {
      const updated = [...cart];
      updated[idx].quantity = qty;
      setCart(updated);
    }
  };

  const removeItem = (idx: number) => {
    setCart(cart.filter((_, i) => i !== idx));
    if (discountIdx === idx) setDiscountIdx(null);
  };

  const addItemDiscount = (idx: number) => {
    const val = Number.parseFloat(discValue);
    if (!val || val <= 0) return;
    const label = discType === "PERCENT" ? `${val}% off` : `${fmt(val)} off`;
    const updated = [...cart];
    updated[idx].discounts.push({ type: discType, value: val, label });
    setCart(updated);
    setDiscValue("");
    setDiscountIdx(null);
  };

  const clearItemDiscounts = (idx: number) => {
    const updated = [...cart];
    updated[idx].discounts = [];
    setCart(updated);
    setDiscountIdx(null);
  };

  const applyOrderDiscount = () => {
    const val = Number.parseFloat(orderDiscValue);
    if (!val || val <= 0) return;
    const label = orderDiscType === "PERCENT" ? `${val}% off order` : `${fmt(val)} off order`;
    setOrderDiscount({ type: orderDiscType, value: val, label });
    setShowOrderDiscount(false);
    setOrderDiscValue("");
  };

  const addProductFromSearch = async (product: FoundProduct) => {
    const price = catalogRetailPrice(product);
    if (price === null) {
      toast.error(noRetailPriceMessage(product));
      return;
    }
    const inventorySummary = await fetchInventorySummary(product.id);
    addProductToCart(product, price, inventorySummary);
    clearProductSearch();
    scanRef.current?.focus();
    toast.success(`Added: ${product.name || product.productNumber}`);
  };

  const applyPriceEdit = (idx: number) => {
    const val = Number.parseFloat(editPriceValue);
    if (Number.isNaN(val) || val < 0) return;
    // A typed price is the cashier's: a trade tier no longer moves it.
    setCart(
      cart.map((item, i) =>
        i === idx ? { ...item, price: val, priceTyped: true, tradePercent: null } : item,
      ),
    );
    setEditingPriceIdx(null);
    setEditPriceValue("");
  };

  const handleCreateOrder = async () => {
    if (cartIsEmpty) {
      toast.error("Cart is empty");
      return;
    }

    try {
      // A discount past what this person may give asks for a manager's PIN
      // and sends again (GAP-06); Cancel leaves the cart as it is.
      const res = await sendWithApproval((discountApproval) =>
        axios.post("/api/sales/orders/create-from-cart", {
          customerId: selectedCustomer?.id || null,
          storeLocation: activeStore?.name || null,
          registerId: selectedRegister?.id || null,
          items: [
            ...cart.map((item) => ({
              productId: item.productId,
              quantity: item.isReturn ? -item.quantity : item.quantity,
              unitPrice: item.price,
              cost: item.cost || undefined,
              discounts: item.discounts,
              isReturn: item.isReturn,
            })),
            // A gift card is its number and amount; the server decides the rest.
            ...cardLines.map(({ type, giftCardNumber, amount }): GiftCardCartLine => ({
              type,
              giftCardNumber,
              amount,
            })),
          ],
          orderDiscount: orderDiscount || undefined,
          deliveryMethod,
          // 0 charges none (create-from-cart).
          deliveryFee: deliveryFeeAmount,
          ...splitBody(split),
          discountApproval,
        }),
      );
      if (!res) return;

      const data = res.data as {
        id: number;
        orderno: string;
        total?: number;
        subtotal?: number;
        taxAmount?: number;
        orderDiscountAmount?: number;
        deliveryFee?: number;
        allowSaleWithoutPayment?: boolean;
      };

      // The server prices the order; tendering anything else -- including
      // falling back to the client's own `netSubtotal` -- is exactly the bug
      // this endpoint was fixed to stop. If the total didn't come back, the
      // order still exists in the DB, so send the register to the order
      // instead of silently re-deriving a number here.
      if (typeof data.total !== "number") {
        toast.error(
          `Order ${data.orderno} created, but no total came back from the server. Open the order to take payment.`,
        );
        router.push(`/app/sales/orders/${data.id}`);
        return;
      }

      toast.success(`Order ${data.orderno} created`);
      setCreatedOrder({
        id: data.id,
        orderno: data.orderno,
        breakdown: {
          subtotal: data.subtotal ?? 0,
          orderDiscountAmount: data.orderDiscountAmount ?? 0,
          deliveryFee: data.deliveryFee ?? 0,
          taxAmount: data.taxAmount ?? 0,
        },
        total: data.total,
        allowSaleWithoutPayment: data.allowSaleWithoutPayment === true,
        holdsGiftCard: cardLines.length > 0,
      });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create order"));
    }
  };

  // Look up a gift card by barcode to validate balance before payment
  const handleGiftCardLookup = async () => {
    const barcode = giftCardBarcode.trim();
    if (!barcode) return;
    setGiftCardError("");
    setGiftCardInfo(null);

    try {
      const res = await axios.get("/api/gift-cards/lookup", { params: { barcode } });
      const card = res.data;
      const closed = closedCardMessage(card);
      if (closed) {
        setGiftCardError(closed);
        return;
      }
      if (card.currentBalance <= 0) {
        setGiftCardError("Gift card has no remaining balance");
        return;
      }
      setGiftCardInfo({
        id: card.id,
        barcode: card.barcode,
        currentBalance: card.currentBalance,
      });
    } catch {
      setGiftCardError("Gift card not found");
    }
  };

  // Find the open till for the current register (needed for payment recording)
  const findOpenTill = async (): Promise<number | undefined> => {
    if (!selectedRegister) return undefined;
    try {
      const res = await axios.get(`/api/registers/${selectedRegister.id}`);
      return res.data.openTillId ?? undefined;
    } catch {
      return undefined;
    }
  };

  const loadStoreCredit = useCallback(async (customerId: number | null | undefined) => {
    if (!customerId) {
      setStoreCredit(null);
      return;
    }
    try {
      const res = await axios.get<{ balance: number }>(`/api/customers/${customerId}/credit`);
      setStoreCredit(Number(res.data.balance) || 0);
    } catch {
      setStoreCredit(null);
    }
  }, []);

  const creditCustomerId = selectedCustomer?.id;
  useEffect(() => {
    void loadStoreCredit(creditCustomerId);
  }, [creditCustomerId, loadStoreCredit]);

  useEffect(() => {
    axios
      .get<OfferedTender[]>("/api/tenders", { params: { for: "register" } })
      .then((res) => setStoreTenders(res.data))
      .catch((err: unknown) => toast.error(getErrorMessage(err, "Failed to load payment types")));
  }, []);

  // Validate the method-specific fields before recording. Returns an error
  // message to toast, or null when the tender is acceptable.
  const validatePayment = (method: PaymentMethodType, amount: number): string | null => {
    if (method === "STORE_CREDIT") {
      return storeCreditProblem(selectedCustomer != null, storeCredit, amount, fmt);
    }
    if (method === "CHECK" && !checkNumber.trim()) {
      return "Enter a check number";
    }
    if (method === "TENDER" && tender?.referenceRequired && !reference.trim()) {
      return `Enter the ${tender.name} reference (the approval or contract number)`;
    }
    if (method === "GIFT_CARD" && !giftCardInfo) {
      return "Look up a gift card first";
    }
    if (method === "GIFT_CARD" && giftCardInfo && giftCardInfo.currentBalance < amount) {
      return `Insufficient gift card balance: ${fmt(giftCardInfo.currentBalance)} available, ${fmt(amount)} required`;
    }
    if (method === "CASH") {
      const tendered = Number.parseFloat(tenderedAmount);
      if (Number.isNaN(tendered) || tendered < amount) {
        return "Tendered amount must be at least the amount being paid";
      }
    }
    return null;
  };

  const handleRecordPayment = async () => {
    if (!createdOrder || !paymentMethod) return;
    const balanceDue = round2(createdOrder.total - paidSoFar);
    const requested = payAmount.trim() === "" ? balanceDue : Number.parseFloat(payAmount);
    if (Number.isNaN(requested) || requested <= 0) {
      toast.error("Enter a payment amount greater than zero");
      return;
    }
    if (requested > balanceDue + 0.005) {
      toast.error(`Payment cannot exceed the ${fmt(balanceDue)} balance due`);
      return;
    }
    const amount = round2(requested);
    if (amount <= 0) return;

    const validationError = validatePayment(paymentMethod, amount);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    if (paymentMethod === "CARD" && registerReader) {
      await startReaderPayment(amount);
      return;
    }

    setPaymentProcessing(true);
    try {
      const tillId = await findOpenTill();
      // Cash goes into a till's drawer and count. With none open at this
      // register it would be in no till's count at all, and the screen now
      // says which register this is, so it says why instead of taking it.
      // "Found", not "is": the till read above answers the same when it fails.
      if (cashNeedsTill(paymentMethod, tillId)) {
        toast.error(
          "No open till was found at this register, so cash can't be taken here. Open its till, or change register.",
        );
        // The line above the amount may have said otherwise, from when the page loaded.
        void loadRegisters("again");
        return;
      }

      const payload: Record<string, unknown> = {
        amount,
        registerId: selectedRegister?.id,
        tillId,
        customerId: selectedCustomer?.id,
        ...tenderFields(paymentMethod, { checkNumber, giftCardInfo, tender, reference }),
      };

      await axios.post(`/api/sales/orders/${createdOrder.id}/payments`, payload);
      void loadStoreCredit(selectedCustomer?.id);

      const change =
        paymentMethod === "CASH"
          ? Math.round((Number.parseFloat(tenderedAmount) - amount) * 100) / 100
          : undefined;
      afterPaymentRecorded(
        amount,
        paymentMethod === "TENDER" ? (tender?.name ?? "") : METHOD_DISPLAY[paymentMethod],
        change,
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to record payment"));
    } finally {
      setPaymentProcessing(false);
    }
  };

  /** A payment is in the books: stay for the next tender, or show the receipt. */
  const afterPaymentRecorded = (amount: number, method: string, change?: number) => {
    if (!createdOrder) return;
    const newPaid = round2(paidSoFar + amount);
    setPaidSoFar(newPaid);
    const remaining = round2(createdOrder.total - newPaid);

    if (remaining > 0.005) {
      // A deposit, or the first half of a split tender. Clear the tender
      // selection and stay on this screen so the next one can be taken --
      // jumping to the receipt here is what made partial payment impossible.
      resetPaymentFlow();
      setPayAmount("");
      toast.success(`${fmt(amount)} recorded — ${fmt(remaining)} still due`);
      return;
    }

    setPaymentComplete(true);
    setPaymentSummary({ method, amount, change, orderno: createdOrder.orderno });
  };

  const {
    registerReader,
    readerPayment,
    startReaderPayment,
    cancelReaderPayment,
    presentTestCard,
  } = useCardReader({
    registerId: selectedRegister?.id,
    orderId: createdOrder?.id,
    findOpenTill,
    setBusy: setPaymentProcessing,
    onApproved: (amount) => afterPaymentRecorded(amount, METHOD_DISPLAY.CARD),
  });

  const resetPaymentFlow = () => {
    setPaymentMethod(null);
    setTender(null);
    setReference("");
    setTenderedAmount("");
    setCheckNumber("");
    setGiftCardBarcode("");
    setGiftCardInfo(null);
    setGiftCardError("");
  };

  const handleNewTransaction = () => {
    // Opened for an order: leave its address, so a reload does not come back to it.
    if (payOrder) router.replace("/app/sales/pos");
    setCart([]);
    setCardLines([]);
    setCardDraft(null);
    chooseCustomer(null);
    setSplit(emptySplit(splitSetup));
    setOrderDiscount(null);
    setReturnMode(false);
    setDeliveryMethod("TAKEN");
    handleDeliveryFeeChange("", false);
    setDiscountIdx(null);
    setCreatedOrder(null);
    setPaidSoFar(0);
    setPayAmount("");
    resetPaymentFlow();
    setPaymentComplete(false);
    setPaymentSummary(null);
    scanRef.current?.focus();
  };

  const clearAll = () => {
    setCart([]);
    setCardLines([]);
    setCardDraft(null);
    chooseCustomer(null);
    setSplit(emptySplit(splitSetup));
    setOrderDiscount(null);
    setReturnMode(false);
    setDeliveryMethod("TAKEN");
    handleDeliveryFeeChange("", false);
    setDiscountIdx(null);
    scanRef.current?.focus();
  };

  // Show register selection screen if no register is chosen or user is changing
  const needsRegisterSelection = !registersLoading && (!selectedRegister || showRegisterSelect);

  // The store allows a sale with nothing paid: the quote becomes an order now.
  const handleProcessUnpaid = async () => {
    if (!createdOrder) return;
    try {
      await axios.put(`/api/sales/orders/${createdOrder.id}`, { status: "ORDER" });
      router.push(`/app/sales/orders/${createdOrder.id}`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Couldn't go ahead with this sale."));
    }
  };

  // Render payment confirmation after successful payment
  if (paymentComplete && paymentSummary) {
    return (
      <PaymentCompletePanel
        summary={paymentSummary}
        fmt={fmt}
        onViewOrder={() => router.push(`/app/sales/orders/${createdOrder?.id}`)}
        onNewTransaction={handleNewTransaction}
      />
    );
  }

  // Which register comes first. A sale just rung chose one before it had a
  // cart; an order opened here to be paid has not, and a payment taken with no
  // register has no till to land in.
  if (registersLoading) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center font-serif">
        <p className="text-brand-gray">Loading registers...</p>
      </div>
    );
  }

  if (needsRegisterSelection) {
    return (
      <RegisterSelect
        registers={allRegisters}
        showCancel={showRegisterSelect && !!selectedRegister}
        onSelect={handleSelectRegister}
        onCancel={() => setShowRegisterSelect(false)}
      />
    );
  }

  // Render payment section after order is created
  if (createdOrder) {
    return (
      <TakePaymentPanel
        order={createdOrder}
        customerName={fullName(selectedCustomer)}
        register={selectedRegister}
        onChangeRegister={handleChangeRegister}
        fmt={fmt}
        balanceDue={round2(createdOrder.total - paidSoFar)}
        paidSoFar={paidSoFar}
        payAmount={payAmount}
        setPayAmount={setPayAmount}
        paymentMethod={paymentMethod}
        setPaymentMethod={setPaymentMethod}
        tenderedAmount={tenderedAmount}
        setTenderedAmount={setTenderedAmount}
        checkNumber={checkNumber}
        setCheckNumber={setCheckNumber}
        giftCardBarcode={giftCardBarcode}
        setGiftCardBarcode={setGiftCardBarcode}
        giftCardInfo={giftCardInfo}
        setGiftCardInfo={setGiftCardInfo}
        giftCardError={giftCardError}
        setGiftCardError={setGiftCardError}
        storeCredit={storeCredit}
        storeTenders={storeTenders}
        tender={tender}
        onChooseTender={(t) => {
          setTender(t);
          setPaymentMethod("TENDER");
        }}
        reference={reference}
        setReference={setReference}
        paymentProcessing={paymentProcessing}
        registerReader={registerReader}
        readerPayment={readerPayment}
        onCancelReaderPayment={cancelReaderPayment}
        onPresentTestCard={presentTestCard}
        onLookupGiftCard={handleGiftCardLookup}
        onRecordPayment={handleRecordPayment}
        onResetFlow={resetPaymentFlow}
        onSkip={() => router.push(`/app/sales/orders/${createdOrder.id}`)}
        onProcessUnpaid={handleProcessUnpaid}
      />
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-4 font-serif">
      {approvalModal}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-brand-blue">Point of Sale</h1>
          {selectedRegister && (
            <p className="text-xs text-brand-gray mt-0.5">
              {selectedRegister.name} -- {selectedRegister.storeLocation?.name}
              <button
                onClick={handleChangeRegister}
                className="ml-2 text-brand-blue underline min-h-[44px] align-middle"
              >
                Change
              </button>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="pos-store" className="sr-only">
            Store
          </label>
          <select
            id="pos-store"
            value={activeStore?.id || ""}
            onChange={(e) => {
              if (e.target.value) setActiveStore(Number.parseInt(e.target.value));
            }}
            className="border border-brand-gray/30 rounded px-2 py-1.5 text-sm"
          >
            <option value="">Select Store</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setReturnMode(!returnMode)}
            className={`px-3 py-1.5 text-sm rounded-full border transition ${
              returnMode
                ? "bg-red-100 text-red-800 border-red-300"
                : "bg-white text-brand-gray border-brand-gray/30 hover:border-brand-blue"
            }`}
          >
            {returnMode ? "Return Mode ON" : "Return Mode"}
          </button>
        </div>
      </div>

      <NoTaxDistrictBanner
        storeName={activeStore?.name}
        configured={taxDistrictConfigured}
        className="mb-4"
      />

      {/* A sale already written, or a gift card, without leaving the register. */}
      <RegisterLookup
        canFindSales={canFindSales}
        canTakePayments={canTakePayments}
        fmt={fmt}
        onTakePayment={(saleId) => router.push(`/app/sales/pos?order=${saleId}`)}
      />

      {/* Customer */}
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4 mb-4">
        {selectedCustomer ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-brand-black">
                {selectedCustomer.firstName} {selectedCustomer.lastName}
              </p>
              <p className="text-xs text-brand-gray">
                {selectedCustomer.email || selectedCustomer.phone || "No contact info"}
              </p>
              {tradeTier && (
                <p className="text-xs text-brand-gold mt-0.5">
                  Trade tier: {tradeTier.name} ({tradeTier.discountPercent}% off retail)
                </p>
              )}
            </div>
            <button
              onClick={() => chooseCustomer(null)}
              className="text-xs text-brand-gray underline min-h-[44px] px-2"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative">
            <label htmlFor="pos-customer" className="block text-xs text-brand-gray mb-1">
              Customer
            </label>
            <input
              id="pos-customer"
              type="text"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder="Search by name, phone, or email..."
              className="w-full border border-brand-gray/30 rounded px-3 py-2.5 text-sm focus:outline-none focus:border-brand-blue"
            />
            {customerResults.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 bg-white border border-brand-gray/20 rounded shadow-lg mt-1 max-h-48 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      chooseCustomer(c);
                      clearCustomerSearch();
                    }}
                    className="w-full text-left px-3 py-3 text-sm hover:bg-brand-linen border-b border-brand-gray/10 last:border-0 min-h-[44px]"
                  >
                    <span className="font-medium">
                      {c.firstName} {c.lastName}
                    </span>
                    {c.phone && <span className="text-brand-gray ml-2">{c.phone}</span>}
                    {c.email && <span className="text-brand-gray ml-2">{c.email}</span>}
                    {c.tradeTier && (
                      <span className="text-brand-gold ml-2">{c.tradeTier.name}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {searchingCustomer && <p className="text-xs text-brand-gray mt-1">Searching...</p>}
          </div>
        )}
      </div>

      {/* Scan input */}
      <div
        className={`border rounded-lg shadow-sm p-4 mb-4 ${
          returnMode ? "bg-red-50 border-red-200" : "bg-white border-brand-gray/20"
        }`}
      >
        <label htmlFor="pos-scan" className="block text-xs text-brand-gray mb-1">
          {returnMode ? "Scan item to return" : "Scan barcode or enter product number"}
        </label>
        <input
          id="pos-scan"
          ref={scanRef}
          type="text"
          value={scanInput}
          onChange={(e) => setScanInput(e.target.value)}
          onKeyDown={handleScanKeyDown}
          placeholder={returnMode ? "Scan return item..." : "Scan or type..."}
          className="w-full border border-brand-gray/30 rounded px-3 py-2.5 text-lg focus:outline-none focus:border-brand-blue"
          autoComplete="off"
        />
        <CardLineForm
          draft={cardDraft}
          onChange={setCardDraft}
          onAdd={addCardLine}
          onCancel={() => {
            setCardDraft(null);
            scanRef.current?.focus();
          }}
        />
      </div>

      {/* Product search */}
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4 mb-4 relative">
        <label htmlFor="pos-product-search" className="block text-xs text-brand-gray mb-1">
          Search products by name
        </label>
        <input
          id="pos-product-search"
          type="text"
          value={productSearch}
          onChange={(e) => setProductSearch(e.target.value)}
          placeholder="Type to search..."
          className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-blue"
        />
        {productResults.length > 0 && (
          <div className="absolute z-10 top-full left-0 right-0 bg-white border border-brand-gray/20 rounded shadow-lg mt-1 max-h-80 overflow-y-auto mx-4">
            {productResults.map((p) => (
              <button
                key={p.id}
                onClick={() => addProductFromSearch(p)}
                className="w-full text-left px-3 py-2.5 text-sm hover:bg-brand-linen border-b border-brand-gray/10 last:border-0 min-h-[44px]"
              >
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-brand-black truncate">{p.name}</p>
                    <p className="text-xs text-brand-gray">
                      {p.productNumber}
                      {p.vendorName && <span> -- {p.vendorName}</span>}
                      {p.categoryName && <span> -- {p.categoryName}</span>}
                    </p>
                  </div>
                  <RetailPriceTag price={catalogRetailPrice(p)} sale={catalogSale(p)} fmt={fmt} />
                </div>
              </button>
            ))}
          </div>
        )}
        {searchingProducts && <p className="text-xs text-brand-gray mt-1">Searching...</p>}
      </div>

      {/* Cart */}
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm overflow-hidden mb-4">
        {cartIsEmpty ? (
          <p className="text-brand-gray text-center py-8">Scan an item to start</p>
        ) : (
          <>
            {cart.map((item, idx) => (
              <CartRow
                key={`${item.productId}-${item.isReturn}`}
                item={item}
                idx={idx}
                fmt={fmt}
                lineTotal={priced.items[idx].lineSubtotal}
                registerStoreName={selectedRegister?.storeLocation.name}
                isEditingPrice={editingPriceIdx === idx}
                editPriceValue={editPriceValue}
                setEditPriceValue={setEditPriceValue}
                onBeginPriceEdit={() => {
                  setEditingPriceIdx(idx);
                  setEditPriceValue(item.price.toFixed(2));
                }}
                onApplyPriceEdit={() => applyPriceEdit(idx)}
                onCancelPriceEdit={() => {
                  setEditingPriceIdx(null);
                  setEditPriceValue("");
                }}
                onDecrementQuantity={() => updateQuantity(idx, item.quantity - 1)}
                onIncrementQuantity={() => updateQuantity(idx, item.quantity + 1)}
                onRemove={() => removeItem(idx)}
                onClearItemDiscounts={() => clearItemDiscounts(idx)}
                isDiscountOpen={discountIdx === idx}
                onToggleDiscount={() => setDiscountIdx(discountIdx === idx ? null : idx)}
                discType={discType}
                setDiscType={setDiscType}
                discValue={discValue}
                setDiscValue={setDiscValue}
                onAddItemDiscount={() => addItemDiscount(idx)}
                onCancelItemDiscount={() => setDiscountIdx(null)}
              />
            ))}
            {cardLines.map((line) => (
              <CardLineRow
                key={`gift-card-${line.giftCardNumber}`}
                line={line}
                fmt={fmt}
                onRemove={() =>
                  setCardLines((prev) =>
                    prev.filter((other) => other.giftCardNumber !== line.giftCardNumber),
                  )
                }
              />
            ))}

            {/* Totals */}
            <div className="p-4 bg-brand-linen border-t border-brand-gray/20 space-y-1">
              <div className="flex justify-between text-sm text-brand-gray">
                <span>{cartItemCount} item(s)</span>
                <span>Subtotal: {fmt(subtotal + cardTotal)}</span>
              </div>
              {orderDiscount && (
                <div className="flex justify-between text-sm text-green-700">
                  <span className="flex items-center gap-2">
                    {orderDiscount.label}
                    <button
                      onClick={() => setOrderDiscount(null)}
                      className="text-[10px] text-red-500 underline"
                    >
                      remove
                    </button>
                  </span>
                  <span>-{fmt(orderDiscountAmount)}</span>
                </div>
              )}
              {deliveryFeeAmount !== 0 && (
                <div className="flex justify-between text-sm text-brand-gray">
                  <span>Delivery</span>
                  <span>{fmt(deliveryFeeAmount)}</span>
                </div>
              )}
              <div className="flex justify-between items-center pt-1">
                <button
                  onClick={() => setShowOrderDiscount(!showOrderDiscount)}
                  className="text-xs text-brand-blue hover:underline"
                >
                  {orderDiscount ? "Change Order Discount" : "Add Order Discount"}
                </button>
                <div className="text-right">
                  <span className="text-xl font-semibold text-brand-black">
                    {fmt(netSubtotal + cardTotal + deliveryFeeAmount)}
                  </span>
                  {/* No tax rate is known client-side (it depends on the tax
                      district/exemption resolved server-side), so this is
                      explicitly pre-tax rather than showing a guessed figure.
                      The real, tax-inclusive total appears on the payment
                      screen once the server returns it. */}
                  <p className="text-[10px] text-brand-gray">
                    + tax, added when the order is created
                  </p>
                </div>
              </div>

              {showOrderDiscount && (
                <div className="flex items-center gap-2 pt-2">
                  <label htmlFor="pos-order-disc-type" className="sr-only">
                    Order discount type
                  </label>
                  <select
                    id="pos-order-disc-type"
                    value={orderDiscType}
                    onChange={(e) => setOrderDiscType(e.target.value as DiscountType)}
                    className="border border-brand-gray/30 rounded px-1.5 py-1 text-xs"
                  >
                    <option value="PERCENT">%</option>
                    <option value="AMOUNT">$</option>
                  </select>
                  <label htmlFor="pos-order-disc-value" className="sr-only">
                    Order discount amount
                  </label>
                  <input
                    id="pos-order-disc-value"
                    type="number"
                    step="0.01"
                    value={orderDiscValue}
                    onChange={(e) => setOrderDiscValue(e.target.value)}
                    placeholder="Amount"
                    className="w-24 border border-brand-gray/30 rounded px-2 py-1 text-xs"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyOrderDiscount();
                    }}
                  />
                  <button
                    onClick={applyOrderDiscount}
                    className="text-xs text-brand-blue hover:underline"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => setShowOrderDiscount(false)}
                    className="text-xs text-brand-gray hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Conveyance + Actions */}
      {!cartIsEmpty && (
        <div className="space-y-3">
          <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4">
            <p className="block text-xs text-brand-gray mb-2">Conveyance</p>
            <div className="flex gap-2">
              {DELIVERY_METHODS.map((method) => (
                <button
                  key={method}
                  onClick={() => setDeliveryMethod(method)}
                  className={`flex-1 px-3 py-2.5 text-sm rounded border transition min-h-[44px] ${
                    deliveryMethod === method
                      ? "bg-brand-blue text-white border-brand-blue"
                      : "bg-white text-brand-gray border-brand-gray/30 hover:border-brand-blue"
                  }`}
                >
                  {DELIVERY_METHOD_LABELS[method]}
                </button>
              ))}
            </div>
            {deliveryMethod === "DELIVERY" && (
              <DeliveryFeeField
                customerId={selectedCustomer?.id ?? null}
                pieces={deliveryPieceCount}
                value={deliveryFee}
                edited={deliveryFeeEdited}
                onChange={handleDeliveryFeeChange}
                fmt={fmt}
              />
            )}
            <SplitSaleField setup={splitSetup} value={split} onChange={setSplit} />
          </div>
          <div className="flex gap-3">
            <Button onClick={handleCreateOrder} className="flex-1 py-3 text-base">
              Create Order
            </Button>
            <Button variant="outline" onClick={clearAll}>
              Clear All
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type MoneyFmt = ReturnType<typeof useMoneyFormatter>;

function RegisterSelect({
  registers,
  showCancel,
  onSelect,
  onCancel,
}: Readonly<{
  registers: Register[];
  showCancel: boolean;
  onSelect: (register: Register) => void;
  onCancel: () => void;
}>) {
  // Group registers by store location for the selection screen
  const registersByStore = registers.reduce<Record<string, Register[]>>((acc, r) => {
    const storeName = r.storeLocation?.name || "Unknown";
    if (!acc[storeName]) acc[storeName] = [];
    acc[storeName].push(r);
    return acc;
  }, {});

  return (
    <div className="max-w-2xl mx-auto py-8 font-serif">
      <h1 className="text-2xl font-semibold text-brand-blue text-center mb-8">
        Select Your Register
      </h1>

      {registers.length === 0 ? (
        <p className="text-brand-gray text-center">
          No active registers found. Set up registers in Admin before using POS.
        </p>
      ) : (
        <div className="space-y-6">
          {Object.entries(registersByStore).map(([storeName, storeRegisters]) => (
            <div key={storeName}>
              <h2 className="text-sm font-medium text-brand-gray uppercase tracking-wide mb-3">
                {storeName}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {storeRegisters.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onSelect(r)}
                    className="h-[60px] px-4 text-left bg-white border border-brand-gray/20 rounded-lg shadow-sm hover:border-brand-blue hover:shadow-md transition text-brand-black font-medium text-base"
                  >
                    {r.name}
                    {/* Which register can take the payment at hand. */}
                    <span className="block text-xs font-normal text-brand-gray">
                      {registerHas(r)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCancel && (
        <div className="mt-8 text-center">
          <button
            onClick={onCancel}
            className="text-sm text-brand-gray underline min-h-[44px] px-4"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function PaymentCompletePanel({
  summary,
  fmt,
  onViewOrder,
  onNewTransaction,
}: Readonly<{
  summary: PaymentSummary;
  fmt: MoneyFmt;
  onViewOrder: () => void;
  onNewTransaction: () => void;
}>) {
  return (
    <div className="max-w-lg mx-auto py-12 font-serif text-center">
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-semibold text-brand-blue mb-6">Payment Complete</h2>
        <div className="space-y-3 text-sm text-brand-black mb-8">
          <p>
            <span className="text-brand-gray">Order:</span> {summary.orderno}
          </p>
          <p>
            <span className="text-brand-gray">Method:</span> {summary.method}
          </p>
          <p>
            <span className="text-brand-gray">Amount:</span> {fmt(summary.amount)}
          </p>
          {summary.change !== undefined && summary.change > 0 && (
            <p className="text-lg font-semibold text-brand-blue mt-4">
              Change Due: {fmt(summary.change)}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <Button onClick={onViewOrder} variant="outline" className="h-[60px] text-base">
            View Order
          </Button>
          <Button onClick={onNewTransaction} className="h-[60px] text-base">
            New Transaction
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which register a payment is being taken at, with the way to another. The
 * payment screen used whichever register the browser remembered and said
 * nothing: an order sent here from its own page could land on a register with
 * no reader and no open till, with no way to change it (owner, 2026-11-28).
 * No changing while a payment is out on a reader: it belongs to that register.
 */
function PaymentRegister({
  register,
  locked,
  onChange,
}: Readonly<{ register: Register | null; locked: boolean; onChange: () => void }>) {
  if (!register) return null;
  // The way to another register sits under the line, not in it: in the line it
  // wrapped mid-phrase beside the amount once a register had a reader to name.
  return (
    <div className="text-xs text-brand-gray mt-1">
      <p>
        At {register.name}, {register.storeLocation?.name} ({registerHas(register)})
      </p>
      {!locked && (
        <button onClick={onChange} className="text-brand-blue underline min-h-[44px]">
          Change register
        </button>
      )}
    </div>
  );
}

function TakePaymentPanel({
  balanceDue,
  paidSoFar,
  payAmount,
  setPayAmount,
  order,
  customerName,
  register,
  onChangeRegister,
  fmt,
  paymentMethod,
  setPaymentMethod,
  tenderedAmount,
  setTenderedAmount,
  checkNumber,
  setCheckNumber,
  giftCardBarcode,
  setGiftCardBarcode,
  giftCardInfo,
  setGiftCardInfo,
  giftCardError,
  setGiftCardError,
  storeCredit,
  storeTenders,
  tender,
  onChooseTender,
  reference,
  setReference,
  paymentProcessing,
  registerReader,
  readerPayment,
  onCancelReaderPayment,
  onPresentTestCard,
  onLookupGiftCard,
  onRecordPayment,
  onResetFlow,
  onSkip,
  onProcessUnpaid,
}: Readonly<{
  order: CreatedOrder;
  /** Who the order is for, shown for an order written earlier. */
  customerName: string | null;
  /** The register the payment is taken at, and the way to another. */
  register: Register | null;
  onChangeRegister: () => void;
  fmt: MoneyFmt;
  paymentMethod: PaymentMethodType | null;
  setPaymentMethod: Dispatch<SetStateAction<PaymentMethodType | null>>;
  tenderedAmount: string;
  setTenderedAmount: Dispatch<SetStateAction<string>>;
  checkNumber: string;
  setCheckNumber: Dispatch<SetStateAction<string>>;
  giftCardBarcode: string;
  setGiftCardBarcode: Dispatch<SetStateAction<string>>;
  giftCardInfo: GiftCardInfo | null;
  setGiftCardInfo: Dispatch<SetStateAction<GiftCardInfo | null>>;
  balanceDue: number;
  paidSoFar: number;
  payAmount: string;
  setPayAmount: Dispatch<SetStateAction<string>>;
  giftCardError: string;
  setGiftCardError: Dispatch<SetStateAction<string>>;
  /** The customer's store credit; null when the order has no customer. */
  storeCredit: number | null;
  /** The store's own payment types offered at the register. */
  storeTenders: OfferedTender[];
  tender: OfferedTender | null;
  onChooseTender: (tender: OfferedTender) => void;
  reference: string;
  setReference: Dispatch<SetStateAction<string>>;
  paymentProcessing: boolean;
  /** This register's card reader; null when it has none. */
  registerReader: RegisterReader | null;
  /** A card payment out on the reader right now. */
  readerPayment: ReaderPayment | null;
  onCancelReaderPayment: () => void;
  onPresentTestCard: (outcome: TestCardOutcome) => void;
  onLookupGiftCard: () => void;
  onRecordPayment: () => void;
  onResetFlow: () => void;
  onSkip: () => void;
  onProcessUnpaid: () => void;
}>) {
  // Everything on this panel is against the amount being tendered NOW, which
  // is the balance due unless the operator is taking a deposit.
  const payingNow = payAmount.trim() === "" ? balanceDue : Number.parseFloat(payAmount) || 0;
  const cashChange =
    tenderedAmount && Number.parseFloat(tenderedAmount) >= payingNow
      ? Math.round((Number.parseFloat(tenderedAmount) - payingNow) * 100) / 100
      : null;
  const choiceLabel =
    paymentMethod === "TENDER"
      ? (tender?.name ?? "")
      : paymentMethod && METHOD_DISPLAY[paymentMethod];

  return (
    <div className="max-w-lg mx-auto py-8 font-serif">
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-6 mb-6">
        <div className="flex justify-between items-start mb-2">
          <div>
            <h2 className="text-xl font-semibold text-brand-blue">Take Payment</h2>
            <p className="text-sm text-brand-gray mt-1">Order {order.orderno}</p>
            <PaymentRegister
              register={register}
              locked={readerPayment !== null}
              onChange={onChangeRegister}
            />
          </div>
          <div className="text-right">
            <span className="text-2xl font-semibold text-brand-black">{fmt(balanceDue)}</span>
            {paidSoFar > 0 && (
              <p className="text-xs text-brand-gray mt-0.5">
                {fmt(paidSoFar)} paid of {fmt(order.total)}
              </p>
            )}
          </div>
        </div>
        {order.breakdown ? (
          <OrderBreakdown breakdown={order.breakdown} fmt={fmt} />
        ) : (
          <p className="text-xs text-brand-gray border-t border-brand-gray/10 pt-2 mt-2">
            {customerName ? `For ${customerName}. ` : ""}
            Order total {fmt(order.total)}. Its lines are on the order.
          </p>
        )}
      </div>

      {paymentMethod && (
        <div className="bg-white border border-brand-gray/20 rounded-lg p-4 mb-4">
          <label htmlFor="pay-amount" className="mb-1 block text-sm text-brand-gray">
            Amount to take now
          </label>
          <div className="flex items-center gap-3">
            <input
              id="pay-amount"
              type="number"
              step="0.01"
              min="0.01"
              max={balanceDue}
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder={balanceDue.toFixed(2)}
              className="w-40 rounded-md border border-brand-accent-gray px-3 py-2 text-right text-brand-black focus:border-brand-blue focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setPayAmount(balanceDue.toFixed(2))}
              className="rounded-md border border-brand-accent-gray px-3 py-2 text-sm"
            >
              Pay in full
            </button>
          </div>
          <PayAmountHint holdsGiftCard={order.holdsGiftCard} balanceDue={balanceDue} fmt={fmt} />
        </div>
      )}

      {!paymentMethod ? (
        <div className="grid grid-cols-2 gap-4">
          {[
            ...PAYMENT_METHODS,
            ...(storeCredit && storeCredit > 0 ? (["STORE_CREDIT"] as const) : []),
          ].map((method) => (
            <button
              key={method}
              onClick={() => setPaymentMethod(method)}
              className="h-[60px] bg-white border border-brand-gray/20 rounded-lg shadow-sm text-brand-black font-semibold text-lg hover:border-brand-blue hover:shadow-md transition"
            >
              {METHOD_DISPLAY[method]}
            </button>
          ))}
          {storeTenders.map((t) => (
            <button
              key={`tender-${t.id}`}
              onClick={() => onChooseTender(t)}
              className="h-[60px] bg-white border border-brand-gray/20 rounded-lg shadow-sm text-brand-black font-semibold text-lg hover:border-brand-blue hover:shadow-md transition"
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold text-brand-black">{choiceLabel} Payment</h3>
            <button
              onClick={onResetFlow}
              className="text-sm text-brand-gray underline min-h-[44px] px-2"
            >
              Back
            </button>
          </div>

          {paymentMethod === "CASH" && (
            <div className="space-y-4">
              <div>
                <label htmlFor="pos-tendered" className="block text-xs text-brand-gray mb-1">
                  Amount Tendered
                </label>
                <input
                  id="pos-tendered"
                  type="number"
                  step="0.01"
                  min={payingNow}
                  value={tenderedAmount}
                  onChange={(e) => setTenderedAmount(e.target.value)}
                  placeholder={payingNow.toFixed(2)}
                  className="w-full border border-brand-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-brand-blue"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRecordPayment();
                  }}
                />
              </div>
              {cashChange !== null && (
                <div className="bg-brand-linen rounded-lg p-3 text-center">
                  <p className="text-sm text-brand-gray">Change Due</p>
                  <p className="text-2xl font-semibold text-brand-blue">{fmt(cashChange)}</p>
                </div>
              )}
            </div>
          )}

          {paymentMethod === "CHECK" && (
            <div>
              <label htmlFor="pos-check-number" className="block text-xs text-brand-gray mb-1">
                Check Number
              </label>
              <input
                id="pos-check-number"
                type="text"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                placeholder="Enter check number"
                className="w-full border border-brand-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-brand-blue"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRecordPayment();
                }}
              />
            </div>
          )}

          {paymentMethod === "CARD" && (
            <CardTenderNote
              registerReader={registerReader}
              readerPayment={readerPayment}
              fmt={fmt}
              onCancel={onCancelReaderPayment}
              onPresentTestCard={onPresentTestCard}
            />
          )}

          {paymentMethod === "GIFT_CARD" && (
            <div className="space-y-3">
              <div>
                <label htmlFor="pos-giftcard" className="block text-xs text-brand-gray mb-1">
                  Gift Card Barcode / Number
                </label>
                <div className="flex gap-2">
                  <input
                    id="pos-giftcard"
                    type="text"
                    value={giftCardBarcode}
                    onChange={(e) => {
                      setGiftCardBarcode(e.target.value);
                      setGiftCardError("");
                      setGiftCardInfo(null);
                    }}
                    placeholder="Scan or enter gift card number"
                    className="flex-1 border border-brand-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-brand-blue"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onLookupGiftCard();
                    }}
                  />
                  <button
                    onClick={onLookupGiftCard}
                    disabled={!giftCardBarcode.trim()}
                    className="px-4 py-3 bg-brand-blue text-white rounded font-semibold text-sm hover:bg-brand-black transition disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
                  >
                    Look Up
                  </button>
                </div>
              </div>
              {giftCardError && <p className="text-sm text-red-600">{giftCardError}</p>}
              {giftCardInfo && (
                <div className="bg-brand-linen rounded-lg p-3">
                  <p className="text-xs text-brand-gray">Card: {giftCardInfo.barcode}</p>
                  <p className="text-sm font-medium text-brand-black">
                    Balance: {fmt(giftCardInfo.currentBalance)}
                  </p>
                  {giftCardInfo.currentBalance < payingNow && (
                    <p className="text-xs text-red-600 mt-1">
                      Insufficient balance for the {fmt(payingNow)} being tendered
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {paymentMethod === "TENDER" && tender && (
            <div>
              <label htmlFor="pos-reference" className="block text-xs text-brand-gray mb-1">
                Reference{tender.referenceRequired ? "" : " (optional)"}
              </label>
              <input
                id="pos-reference"
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Approval or contract number"
                maxLength={REFERENCE_MAX}
                className="w-full border border-brand-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-brand-blue"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRecordPayment();
                }}
              />
            </div>
          )}

          {paymentMethod === "STORE_CREDIT" && (
            <div className="bg-brand-linen rounded-lg p-3">
              <p className="text-sm font-medium text-brand-black">
                Store credit: {fmt(storeCredit ?? 0)}
              </p>
              {(storeCredit ?? 0) < payingNow && (
                <p className="text-xs text-red-600 mt-1">
                  Not enough credit for the {fmt(payingNow)} being tendered
                </p>
              )}
            </div>
          )}

          <Button
            onClick={onRecordPayment}
            disabled={paymentProcessing || readerPayment !== null}
            fullWidth
            className="h-[60px] text-lg"
          >
            {tenderButtonLabel(
              paymentProcessing || readerPayment !== null,
              paymentMethod === "CARD" && registerReader !== null,
              choiceLabel ?? "",
              fmt(payingNow),
            )}
          </Button>
        </div>
      )}

      {order.allowSaleWithoutPayment && (
        <div className="mt-6">
          <Button variant="secondary" fullWidth onClick={onProcessUnpaid}>
            Go ahead with no payment
          </Button>
        </div>
      )}

      <SkipPayment
        mustFinish={order.holdsGiftCard && paidSoFar > 0}
        balanceDue={balanceDue}
        fmt={fmt}
        onSkip={onSkip}
      />
    </div>
  );
}

/**
 * How the sale just rung reached its total, from the server's pricing: the tax
 * line the cart screen couldn't show, now that the rate is known.
 */
function OrderBreakdown({
  breakdown,
  fmt,
}: Readonly<{ breakdown: NonNullable<CreatedOrder["breakdown"]>; fmt: MoneyFmt }>) {
  return (
    <div className="text-xs text-brand-gray space-y-0.5 border-t border-brand-gray/10 pt-2 mt-2">
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{fmt(breakdown.subtotal)}</span>
      </div>
      {breakdown.orderDiscountAmount > 0 && (
        <div className="flex justify-between text-green-700">
          <span>Discount</span>
          <span>-{fmt(breakdown.orderDiscountAmount)}</span>
        </div>
      )}
      {breakdown.deliveryFee > 0 && (
        <div className="flex justify-between">
          <span>Delivery</span>
          <span>{fmt(breakdown.deliveryFee)}</span>
        </div>
      )}
      <div className="flex justify-between">
        <span>Tax</span>
        <span>{fmt(breakdown.taxAmount)}</span>
      </div>
    </div>
  );
}

/**
 * What the amount to take means. Owner, 2026-11-11: a sale with a gift card
 * "must be paid in full", so it takes no deposit; a split across tenders still
 * pays it in full.
 */
function PayAmountHint({
  holdsGiftCard,
  balanceDue,
  fmt,
}: Readonly<{ holdsGiftCard: boolean; balanceDue: number; fmt: MoneyFmt }>) {
  if (holdsGiftCard) {
    return (
      <p className="mt-1 text-xs text-brand-gray">
        This sale has a gift card, so it&apos;s paid in full now. Leave blank to take the full{" "}
        {fmt(balanceDue)}, or enter less to split it across tenders. The card goes live with the
        last one.
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-brand-gray">
      Leave blank to take the full {fmt(balanceDue)} balance. Enter less to take a deposit or split
      across tenders — the order stays open until it is paid off.
    </p>
  );
}

/**
 * Leave the register without finishing the payment. Not once part of a sale
 * with a gift card is paid: leaving then would make what was taken a deposit,
 * and its card waits for the rest.
 */
function SkipPayment({
  mustFinish,
  balanceDue,
  fmt,
  onSkip,
}: Readonly<{ mustFinish: boolean; balanceDue: number; fmt: MoneyFmt; onSkip: () => void }>) {
  if (mustFinish) {
    return (
      <p className="mt-6 text-center text-sm text-brand-gray">
        This sale has a gift card: take the {fmt(balanceDue)} still due to finish it.
      </p>
    );
  }
  return (
    <div className="mt-6 text-center">
      <button onClick={onSkip} className="text-sm text-brand-gray underline min-h-[44px] px-4">
        Skip payment and view order
      </button>
    </div>
  );
}

/** The form a GC quick code opens: the card's number (scanned) and its amount. */
function CardLineForm({
  draft,
  onChange,
  onAdd,
  onCancel,
}: Readonly<{
  draft: CardDraft | null;
  onChange: Dispatch<SetStateAction<CardDraft | null>>;
  onAdd: () => void;
  onCancel: () => void;
}>) {
  if (!draft) return null;
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onAdd();
    }
  };
  return (
    <div className="mt-3 rounded border border-brand-gray/20 bg-brand-linen p-3">
      <p className="mb-2 text-sm font-medium text-brand-black">{draft.label}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="pos-card-number" className="block text-xs text-brand-gray mb-1">
            Card number
          </label>
          <input
            id="pos-card-number"
            type="text"
            value={draft.number}
            onChange={(e) => onChange({ ...draft, number: e.target.value })}
            onKeyDown={onEnter}
            placeholder="Scan the card"
            className="w-full border border-brand-gray/30 rounded px-3 py-2 font-mono focus:outline-none focus:border-brand-blue"
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="w-32">
          <label htmlFor="pos-card-amount" className="block text-xs text-brand-gray mb-1">
            Amount
          </label>
          <input
            id="pos-card-amount"
            type="number"
            step="0.01"
            min="0.01"
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
            onKeyDown={onEnter}
            placeholder="0.00"
            className="w-full border border-brand-gray/30 rounded px-3 py-2 text-right focus:outline-none focus:border-brand-blue"
          />
        </div>
        <Button onClick={onAdd}>Add to sale</Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A gift card on the cart: its number, whether it's a reload, its amount. */
function CardLineRow({
  line,
  fmt,
  onRemove,
}: Readonly<{ line: CardLine; fmt: MoneyFmt; onRemove: () => void }>) {
  return (
    <div className="border-b border-brand-gray/10 p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-brand-black">
            {line.reload ? GIFT_CARD_LINE_NAME.RELOAD : GIFT_CARD_LINE_NAME.NEW}
          </p>
          <p className="text-xs text-brand-gray font-mono">{line.giftCardNumber}</p>
          <p className="text-xs text-brand-gray mt-0.5">Goes live when the sale is paid in full</p>
        </div>
        <div className="text-right min-w-[80px] text-sm font-medium">{fmt(line.amount)}</div>
        <button onClick={onRemove} className="text-[10px] text-red-400 hover:text-red-600">
          X
        </button>
      </div>
    </div>
  );
}

type CartRowProps = Readonly<{
  item: CartItem;
  idx: number;
  fmt: MoneyFmt;
  /** Line total after item-level discounts (priced.items[idx].lineSubtotal) -- never recomputed here. */
  lineTotal: number;
  registerStoreName?: string;
  isEditingPrice: boolean;
  editPriceValue: string;
  setEditPriceValue: Dispatch<SetStateAction<string>>;
  onBeginPriceEdit: () => void;
  onApplyPriceEdit: () => void;
  onCancelPriceEdit: () => void;
  onDecrementQuantity: () => void;
  onIncrementQuantity: () => void;
  onRemove: () => void;
  onClearItemDiscounts: () => void;
  isDiscountOpen: boolean;
  onToggleDiscount: () => void;
  discType: DiscountType;
  setDiscType: Dispatch<SetStateAction<DiscountType>>;
  discValue: string;
  setDiscValue: Dispatch<SetStateAction<string>>;
  onAddItemDiscount: () => void;
  onCancelItemDiscount: () => void;
}>;

function CartRow({
  item,
  idx,
  fmt,
  lineTotal,
  registerStoreName,
  isEditingPrice,
  editPriceValue,
  setEditPriceValue,
  onBeginPriceEdit,
  onApplyPriceEdit,
  onCancelPriceEdit,
  onDecrementQuantity,
  onIncrementQuantity,
  onRemove,
  onClearItemDiscounts,
  isDiscountOpen,
  onToggleDiscount,
  discType,
  setDiscType,
  discValue,
  setDiscValue,
  onAddItemDiscount,
  onCancelItemDiscount,
}: CartRowProps) {
  const onHandHere = registerStoreName ? onHandAt(item, registerStoreName) : 0;
  // An untyped line keeps its sale while a tier prices it below the sale price:
  // its list (`retail`) is still the sale price it was added at.
  const onSale = lineSale(item.priceTyped ? item.price : item.retail, item.sale);

  return (
    <div className={`border-b border-brand-gray/10 p-3 ${item.isReturn ? "bg-red-50" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-brand-black truncate">{item.name}</p>
            {item.isReturn && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-200 text-red-800">
                RETURN
              </span>
            )}
          </div>
          <p className="text-xs text-brand-gray">{item.productNumber}</p>
          {onSale && (
            <p className="text-xs mt-0.5">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 font-semibold">
                SALE
              </span>{" "}
              <span className="text-brand-gray">
                Regular <s>{fmt(onSale.regularPrice)}</s>
              </span>
            </p>
          )}
          {registerStoreName && (
            <p className="text-xs mt-1">
              <span className="text-brand-gray">Source: </span>
              <span className="font-medium text-brand-blue">{registerStoreName}</span>
              {onHandHere > 0 ? (
                <span className="text-brand-gray"> ({onHandHere} on hand)</span>
              ) : (
                <span className="text-red-700 font-medium"> -- 0 on hand here</span>
              )}
            </p>
          )}
          {item.inventorySummary.length > 0 && (
            <p className="text-xs text-brand-gray mt-0.5">
              <span className="uppercase tracking-wide text-[10px]">Stock:</span>{" "}
              {item.inventorySummary.map((s) => `${s.locationName} ${s.available}`).join(" · ")}
            </p>
          )}
          {item.discounts.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {item.discounts.map((d, di) => (
                <span
                  key={di}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800"
                >
                  {d.label}
                </span>
              ))}
              <button onClick={onClearItemDiscounts} className="text-[10px] text-red-500 underline">
                clear
              </button>
            </div>
          )}
        </div>

        {/* Qty controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={onDecrementQuantity}
            className="w-7 h-7 rounded border border-brand-gray/30 text-brand-gray hover:bg-brand-linen text-sm"
          >
            -
          </button>
          <span className="w-8 text-center text-sm">{item.quantity}</span>
          <button
            onClick={onIncrementQuantity}
            className="w-7 h-7 rounded border border-brand-gray/30 text-brand-gray hover:bg-brand-linen text-sm"
          >
            +
          </button>
        </div>

        {/* Price and actions */}
        <div className="text-right min-w-[80px]">
          {isEditingPrice ? (
            <div className="flex items-center gap-1">
              <label htmlFor={`pos-price-${idx}`} className="sr-only">
                Edit price
              </label>
              <input
                id={`pos-price-${idx}`}
                type="number"
                step="0.01"
                value={editPriceValue}
                onChange={(e) => setEditPriceValue(e.target.value)}
                onBlur={onApplyPriceEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onApplyPriceEdit();
                  if (e.key === "Escape") onCancelPriceEdit();
                }}
                className="w-20 text-xs border border-brand-gray/30 rounded px-1.5 py-1 text-right"
                autoFocus
              />
            </div>
          ) : (
            <button
              onClick={onBeginPriceEdit}
              className="text-sm font-medium hover:text-brand-blue"
              title="Click to edit price"
            >
              {fmt(lineTotal)}
            </button>
          )}
          {item.discounts.length > 0 && !isEditingPrice && (
            <p className="text-[10px] text-brand-gray line-through">
              {fmt(item.price * item.quantity)}
            </p>
          )}
          {item.tradePercent !== null && !isEditingPrice && (
            <p className="text-[10px] text-brand-gold" title={`Retail ${fmt(item.retail)} each`}>
              {tradeLabel(item.tradePercent)}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <button
            onClick={onToggleDiscount}
            className="text-[10px] text-brand-blue hover:underline"
          >
            Disc
          </button>
          <button onClick={onRemove} className="text-[10px] text-red-400 hover:text-red-600">
            X
          </button>
        </div>
      </div>

      {/* Inline discount form */}
      {isDiscountOpen && (
        <div className="flex items-center gap-2 mt-2 pl-1">
          <label htmlFor={`pos-item-disc-type-${idx}`} className="sr-only">
            Discount type
          </label>
          <select
            id={`pos-item-disc-type-${idx}`}
            value={discType}
            onChange={(e) => setDiscType(e.target.value as DiscountType)}
            className="border border-brand-gray/30 rounded px-1.5 py-1 text-xs"
          >
            <option value="PERCENT">%</option>
            <option value="AMOUNT">$</option>
          </select>
          <label htmlFor={`pos-item-disc-value-${idx}`} className="sr-only">
            Discount amount
          </label>
          <input
            id={`pos-item-disc-value-${idx}`}
            type="number"
            step="0.01"
            value={discValue}
            onChange={(e) => setDiscValue(e.target.value)}
            placeholder="Amount"
            className="w-20 border border-brand-gray/30 rounded px-2 py-1 text-xs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddItemDiscount();
            }}
          />
          <button onClick={onAddItemDiscount} className="text-xs text-brand-blue hover:underline">
            Apply
          </button>
          <button
            onClick={onCancelItemDiscount}
            className="text-xs text-brand-gray hover:underline"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
