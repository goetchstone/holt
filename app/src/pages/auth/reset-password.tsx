// /app/src/pages/auth/reset-password.tsx

import { useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import { getPublicBranding } from "@/lib/appSettings";
import { useBranding } from "@/components/branding/BrandingProvider";

// Public page (reached from the reset email). The token rides the query
// string; validation happens server-side on submit — single-use + 1h expiry.
export const getServerSideProps: GetServerSideProps = async () => {
  if (!process.env.AUTH_LOCAL_ENABLED) {
    return { notFound: true };
  }
  return { props: { branding: await getPublicBranding() } };
};

export default function ResetPassword() {
  const router = useRouter();
  const branding = useBranding();
  const token = typeof router.query.token === "string" ? router.query.token : "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not reset the password");
        return;
      }
      setDone(true);
    } catch {
      setError("Could not reset the password");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-sh-linen px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-lg">
        <div className="mb-6 flex justify-center">
          <BrandLogo
            appName={branding.appName}
            logoUrl={branding.loginLogoUrl ?? branding.logoUrl}
            className="h-14 w-auto"
            wordmarkClassName="font-serif text-3xl font-semibold text-sh-navy"
          />
        </div>

        {done ? (
          <div className="text-center text-sm text-sh-gray">
            <p>Your password has been updated.</p>
            <p className="mt-4">
              <Link href="/auth/login" className="text-sh-navy hover:underline">
                Sign in with your new password
              </Link>
            </p>
          </div>
        ) : !token ? (
          <p className="text-center text-sm text-sh-gray">
            This reset link is incomplete — open the link from the email, or{" "}
            <Link href="/auth/forgot-password" className="text-sh-navy hover:underline">
              request a new one
            </Link>
            .
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div>
              <label htmlFor="rp-password" className="mb-1 block text-sm font-medium text-sh-navy">
                New password
              </label>
              <input
                id="rp-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-h-[44px] w-full rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="rp-confirm" className="mb-1 block text-sm font-medium text-sh-navy">
                Confirm password
              </label>
              <input
                id="rp-confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="min-h-[44px] w-full rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" fullWidth disabled={submitting}>
              {submitting ? "Saving..." : "Set new password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
