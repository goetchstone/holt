"use client";

// /app/src/app/(dashboard)/app/account/AccountView.tsx
//
// My Account: identity summary + change-password form. The form only renders
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
        <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
      </div>
    );
  }
  if (!me.data) {
    return <p className="py-16 text-center text-sh-gray">No staff record for this account.</p>;
  }

  return (
    <div className="max-w-lg space-y-8 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-sh-navy">My Account</h1>
        <p className="text-sm text-sh-gray">Your sign-in identity on this system.</p>
      </div>

      <dl className="space-y-2 rounded-lg border border-sh-gray/20 bg-white p-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-sh-gray">Name</dt>
          <dd className="font-semibold text-sh-navy">{me.data.displayName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-sh-gray">Email</dt>
          <dd>{me.data.email ?? "--"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-sh-gray">Role</dt>
          <dd>{me.data.role}</dd>
        </div>
      </dl>

      {me.data.localAuthEnabled ? (
        <form onSubmit={submit} className="space-y-3">
          <h2 className="text-lg font-semibold text-sh-navy">
            {me.data.hasLocalPassword ? "Change password" : "Set a password"}
          </h2>
          {me.data.hasLocalPassword && (
            <div>
              <label htmlFor="acc-current" className="mb-1 block text-xs font-medium text-sh-gray">
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
            <label htmlFor="acc-next" className="mb-1 block text-xs font-medium text-sh-gray">
              New password (min 8 characters)
            </label>
            <input
              id="acc-next"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="acc-confirm" className="mb-1 block text-xs font-medium text-sh-gray">
              Confirm new password
            </label>
            <input
              id="acc-confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={changePassword.isPending}
            className="min-h-[44px] rounded-lg bg-sh-navy px-6 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
          >
            {changePassword.isPending ? "Saving..." : "Save password"}
          </button>
        </form>
      ) : (
        <p className="text-sm text-sh-gray">
          This deployment signs in through an identity provider — there is no local password to
          manage.
        </p>
      )}
    </div>
  );
}
