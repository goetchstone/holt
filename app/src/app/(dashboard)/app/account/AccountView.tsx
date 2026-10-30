"use client";

// /app/src/app/(dashboard)/app/account/AccountView.tsx
//
// My Account: identity summary, change-password form, and the register PIN a
// manager approves discounts with (lib/sales/discountApproval.ts). The password form only renders
// when local accounts are enabled; an OAuth-only user setting their FIRST
// password skips the current-password field (the server applies the same
// rule — proof of the old password is required only when one exists).

import { useState } from "react";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/trpc/client";

export function AccountView() {
  const me = api.account.me.useQuery();
  const changePassword = api.account.changePassword.useMutation();
  const utils = api.useUtils();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast.error("New passwords do not match");
      return;
    }
    try {
      await changePassword.mutateAsync({ currentPassword: current, newPassword: next });
      toast.success("Password updated");
      setCurrent("");
      setNext("");
      setConfirm("");
      utils.account.me.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the password");
    }
  };

  if (me.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
      </div>
    );
  }
  if (!me.data) {
    return <p className="py-16 text-center text-brand-gray">No staff record for this account.</p>;
  }

  return (
    <div className="max-w-lg space-y-8 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-brand-navy">My Account</h1>
        <p className="text-sm text-brand-gray">Your sign-in identity on this system.</p>
      </div>

      <dl className="space-y-2 rounded-lg border border-brand-gray/20 bg-white p-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-brand-gray">Name</dt>
          <dd className="font-semibold text-brand-navy">{me.data.displayName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-brand-gray">Email</dt>
          <dd>{me.data.email ?? "--"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-brand-gray">Role</dt>
          <dd>{me.data.role}</dd>
        </div>
      </dl>

      {me.data.localAuthEnabled ? (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-lg font-semibold text-brand-navy">
            {me.data.hasLocalPassword ? "Change password" : "Set a password"}
          </h2>
          {me.data.hasLocalPassword && (
            <div>
              <label
                htmlFor="acc-current"
                className="mb-1 block text-xs font-medium text-brand-gray"
              >
                Current password
              </label>
              <input
                id="acc-current"
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
              />
            </div>
          )}
          <div>
            <label htmlFor="acc-next" className="mb-1 block text-xs font-medium text-brand-gray">
              New password (min 12 characters)
            </label>
            <input
              id="acc-next"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="acc-confirm" className="mb-1 block text-xs font-medium text-brand-gray">
              Confirm new password
            </label>
            <input
              id="acc-confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={changePassword.isPending}
            className="min-h-[44px] rounded-lg bg-brand-navy px-6 text-sm font-semibold text-white transition hover:bg-brand-blue disabled:opacity-50"
          >
            {changePassword.isPending ? "Saving..." : "Save password"}
          </button>
        </form>
      ) : (
        <p className="text-sm text-brand-gray">
          This deployment signs in through an identity provider — there is no local password to
          manage.
        </p>
      )}

      <PinForm hasPin={me.data.hasPin} needsPassword={me.data.hasLocalPassword} />
    </div>
  );
}

/**
 * The register PIN. A manager whose role may approve discounts picks their name
 * at the register and enters it; five wrong tries lock it for fifteen minutes,
 * and setting it again unlocks it.
 */
function PinForm({ hasPin, needsPassword }: Readonly<{ hasPin: boolean; needsPassword: boolean }>) {
  const setPin = api.account.setPin.useMutation();
  const utils = api.useUtils();
  const [current, setCurrent] = useState("");
  const [pin, setPinValue] = useState("");
  const [confirm, setConfirm] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pin !== confirm) {
      toast.error("The PINs do not match");
      return;
    }
    try {
      await setPin.mutateAsync({ currentPassword: current, pin });
      toast.success("PIN saved");
      setCurrent("");
      setPinValue("");
      setConfirm("");
      utils.account.me.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the PIN");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="text-lg font-semibold text-brand-navy">
        {hasPin ? "Change register PIN" : "Set a register PIN"}
      </h2>
      <p className="text-sm text-brand-gray">
        If your role can approve discounts, you approve one at the register by choosing your name
        and entering this PIN.
      </p>
      {needsPassword && (
        <div>
          <label htmlFor="pin-current" className="mb-1 block text-xs font-medium text-brand-gray">
            Current password
          </label>
          <input
            id="pin-current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
          />
        </div>
      )}
      <div>
        <label htmlFor="pin-new" className="mb-1 block text-xs font-medium text-brand-gray">
          PIN (4 to 8 digits)
        </label>
        <input
          id="pin-new"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          required
          pattern="[0-9]{4,8}"
          value={pin}
          onChange={(e) => setPinValue(e.target.value)}
          className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
        />
      </div>
      <div>
        <label htmlFor="pin-confirm" className="mb-1 block text-xs font-medium text-brand-gray">
          Confirm PIN
        </label>
        <input
          id="pin-confirm"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          required
          pattern="[0-9]{4,8}"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
        />
      </div>
      <button
        type="submit"
        disabled={setPin.isPending}
        className="min-h-[44px] rounded-lg bg-brand-navy px-6 text-sm font-semibold text-white transition hover:bg-brand-blue disabled:opacity-50"
      >
        {setPin.isPending ? "Saving..." : "Save PIN"}
      </button>
    </form>
  );
}
