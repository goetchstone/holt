"use client";

// /app/src/app/(dashboard)/app/sales/gift-card-sale/GiftCardSaleView.tsx
//
// Gift card sale / activation register flow body -- App Router port of the legacy
// pages/sales/gift-card-sale.tsx. Steps: quick code -> amount -> scan barcode ->
// done. The legacy page used ScannerLayout (a focused register screen); the
// focused feel is PRESERVED via the local GiftCardLayout wrapper (the dashboard
// chrome still supplies the top nav). Reads/writes the shared /api/gift-cards/*
// REST endpoints via fetch, exactly as before. The redirected quick code arrives
// on the ?code= search param (next/navigation), replacing the legacy router.query.

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "react-toastify";
import { CreditCard, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type Step = "code" | "amount" | "scan" | "done";

interface Preset {
  id: number;
  code: string;
  amount: number | null;
  label: string;
}

interface ActivationResult {
  card: {
    id: number;
    barcode: string;
    currentBalance: number;
  };
}

interface HistoryItem {
  barcode: string;
  amount: number;
  timestamp: Date;
}

const STEP_SEQUENCE: Step[] = ["code", "amount", "scan"];

type StepState = "current" | "done" | "future";

// Where a step circle sits relative to the active step, for indicator styling.
function stepState(step: Step, target: Step, index: number): StepState {
  if (step === target) return "current";
  if (step === "done" || STEP_SEQUENCE.indexOf(step) > index) return "done";
  return "future";
}

const STEP_CIRCLE_CLASSES: Record<StepState, string> = {
  current: "bg-sh-blue text-white",
  done: "bg-green-500 text-white",
  future: "bg-sh-gray/20 text-sh-gray",
};

export function GiftCardSaleView() {
  const searchParams = useSearchParams();
  const fmt = useMoneyFormatter();
  const [step, setStep] = useState<Step>("code");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [amount, setAmount] = useState("");
  const [barcode, setBarcode] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [autoResolved, setAutoResolved] = useState(false);

  const codeRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
    if (step === "amount") amountRef.current?.focus();
    if (step === "scan") barcodeRef.current?.focus();
  }, [step]);

  const resolveCodeValue = useCallback(async (code: string) => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;

    try {
      const res = await fetch(
        `/api/gift-cards/presets/resolve?code=${encodeURIComponent(trimmed)}`,
      );
      if (!res.ok) {
        toast.error("Unknown quick code");
        return;
      }

      const p: Preset = await res.json();
      setPreset(p);

      if (p.amount !== null) {
        setAmount(String(p.amount));
        setStep("scan");
      } else {
        setStep("amount");
      }
    } catch {
      toast.error("Error looking up code");
    }
  }, []);

  const resolveCode = async () => {
    await resolveCodeValue(codeInput);
  };

  // Auto-resolve code from query parameter (e.g. when redirected from POS page)
  useEffect(() => {
    if (autoResolved) return;
    const queryCode = searchParams?.get("code");
    if (queryCode && queryCode.trim()) {
      setAutoResolved(true);
      setCodeInput(queryCode.trim().toUpperCase());
      resolveCodeValue(queryCode);
    }
  }, [searchParams, autoResolved, resolveCodeValue]);

  const confirmAmount = () => {
    const val = Number.parseFloat(amount);
    if (!val || val <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    setStep("scan");
  };

  const activateCard = async () => {
    const trimmed = barcode.trim();
    if (!trimmed) return;

    const val = Number.parseFloat(amount);
    if (!val || val <= 0) {
      toast.error("Invalid amount");
      return;
    }

    setActivating(true);
    try {
      const res = await fetch("/api/gift-cards/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: trimmed, amount: val }),
      });

      if (res.ok) {
        const data: ActivationResult = await res.json();
        toast.success(`Card activated: ${fmt(data.card.currentBalance)}`);
        setHistory((prev) => [{ barcode: trimmed, amount: val, timestamp: new Date() }, ...prev]);
        setStep("done");
      } else {
        const err = await res.json();
        toast.error(err.error || "Activation failed");
      }
    } catch {
      toast.error("Error activating card");
    } finally {
      setActivating(false);
    }
  };

  const reset = () => {
    setStep("code");
    setPreset(null);
    setAmount("");
    setBarcode("");
    setCodeInput("");
  };

  const handleCodeKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") resolveCode();
  };
  const handleAmountKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") confirmAmount();
  };
  const handleBarcodeKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") activateCard();
  };

  return (
    <GiftCardLayout>
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-6">
        {STEP_SEQUENCE.map((s, i) => {
          const state = stepState(step, s, i);
          return (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-serif-condensed font-semibold ${STEP_CIRCLE_CLASSES[state]}`}
              >
                {state === "done" ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              {i < 2 && <div className="w-8 h-px bg-sh-gray/30" />}
            </div>
          );
        })}
      </div>

      {/* Step: Enter quick code */}
      {step === "code" && (
        <div className="text-center">
          <CreditCard className="w-12 h-12 text-sh-blue mx-auto mb-3" />
          <h2 className="text-xl font-serif font-semibold text-sh-blue mb-4">
            Enter Gift Card Code
          </h2>
          <label htmlFor="gc-code" className="sr-only">
            Gift card quick code
          </label>
          <input
            id="gc-code"
            ref={codeRef}
            type="text"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={handleCodeKey}
            placeholder="GC, GC25, GC50..."
            className="w-full border border-sh-gray rounded-lg px-4 py-3 text-center text-xl font-serif text-sh-black mb-4"
            autoComplete="off"
          />
          <Button onClick={resolveCode} fullWidth>
            Continue
          </Button>
        </div>
      )}

      {/* Step: Enter custom amount */}
      {step === "amount" && (
        <div className="text-center">
          <h2 className="text-xl font-serif font-semibold text-sh-blue mb-2">
            {preset?.label || "Custom Gift Card"}
          </h2>
          <p className="text-sh-gray font-serif mb-4">Enter the gift card amount</p>
          <div className="relative mb-4">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xl text-sh-gray font-serif">
              $
            </span>
            <label htmlFor="gc-amount" className="sr-only">
              Gift card amount
            </label>
            <input
              id="gc-amount"
              ref={amountRef}
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={handleAmountKey}
              placeholder="0.00"
              step="0.01"
              min="0.01"
              className="w-full border border-sh-gray rounded-lg pl-8 pr-4 py-3 text-center text-2xl font-serif text-sh-black"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={reset} className="flex-1">
              Back
            </Button>
            <Button onClick={confirmAmount} className="flex-1">
              Continue
            </Button>
          </div>
        </div>
      )}

      {/* Step: Scan card barcode */}
      {step === "scan" && (
        <div className="text-center">
          <h2 className="text-xl font-serif font-semibold text-sh-blue mb-2">
            {fmt(Number.parseFloat(amount))} Gift Card
          </h2>
          <p className="text-sh-gray font-serif mb-4">Scan the physical card barcode</p>
          <label htmlFor="gc-barcode" className="sr-only">
            Gift card barcode
          </label>
          <input
            id="gc-barcode"
            ref={barcodeRef}
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={handleBarcodeKey}
            placeholder="Scan barcode..."
            className="w-full border border-sh-gray rounded-lg px-4 py-3 text-center text-lg font-mono text-sh-black mb-4"
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={reset} className="flex-1">
              Cancel
            </Button>
            <Button onClick={activateCard} disabled={activating} className="flex-1">
              {activating ? "Activating..." : "Activate Card"}
            </Button>
          </div>
        </div>
      )}

      {/* Step: Done */}
      {step === "done" && (
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <Check className="w-8 h-8 text-green-700" />
          </div>
          <h2 className="text-xl font-serif font-semibold text-green-700 mb-2">Card Activated</h2>
          <p className="text-sh-black font-serif mb-1">
            <span className="font-semibold">{fmt(Number.parseFloat(amount))}</span> loaded
          </p>
          <p className="text-sh-gray font-mono text-sm mb-6">{barcode}</p>
          <Button onClick={reset} fullWidth>
            Sell Another Card
          </Button>
        </div>
      )}

      {/* Recent activations */}
      {history.length > 0 && (
        <div className="mt-8">
          <h3 className="font-serif font-semibold text-sh-blue text-sm mb-2">Recent Activations</h3>
          <div className="space-y-1">
            {history.slice(0, 10).map((h, i) => (
              <div
                key={i}
                className="flex justify-between items-center py-2 px-3 bg-sh-stripe rounded text-sm"
              >
                <span className="font-mono text-sh-gray">{h.barcode}</span>
                <span className="font-serif font-semibold text-sh-blue">{fmt(h.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </GiftCardLayout>
  );
}

// Focused register-screen wrapper preserving the legacy ScannerLayout feel
// (centered, narrow, no extra dashboard padding) inside the App Router shell.
function GiftCardLayout({ children }: { children: React.ReactNode }) {
  return <div className="max-w-lg mx-auto mt-4">{children}</div>;
}
