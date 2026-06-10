// /app/src/pages/auth/login.tsx

import { useState } from "react";
import type { GetServerSideProps } from "next";
import { signIn } from "next-auth/react";
import { useRouter } from "next/router";
import Link from "next/link";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import { getPublicBranding } from "@/lib/appSettings";
import { PRODUCT } from "@/lib/branding";
import { useBranding } from "@/components/branding/BrandingProvider";
import { getEnabledAuthMethodsResolved } from "@/lib/auth/authMethodsResolved";
import type { AuthMethodDef } from "@/lib/auth/authMethods";

interface LoginProps {
  methods: AuthMethodDef[];
}

// Public page (no auth gate -- this is the sign-in entry point). It resolves
// branding directly so the tenant's logo/name show before any session exists,
// and reads the enabled auth methods so only configured sign-in options render.
export const getServerSideProps: GetServerSideProps<LoginProps> = async () => {
  return {
    props: {
      branding: await getPublicBranding(),
      methods: await getEnabledAuthMethodsResolved(),
    },
  };
};

export default function Login({ methods }: LoginProps) {
  const router = useRouter();
  const branding = useBranding();
  const callbackUrl = (router.query.callbackUrl as string) || "/app";

  const oauthMethods = methods.filter((m) => m.type === "oauth");
  const localMethod = methods.find((m) => m.type === "credentials");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOAuth = (id: string) => signIn(id, { callbackUrl });

  const handleLocalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
      callbackUrl,
    });
    setSubmitting(false);
    if (result?.error) {
      setError("Incorrect email or password.");
      return;
    }
    router.push(result?.url || callbackUrl);
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

        {methods.length === 0 && (
          <p className="text-center text-sm text-sh-gray">
            No sign-in methods are configured. Set up an identity provider or enable local accounts
            to sign in.
          </p>
        )}

        {oauthMethods.length > 0 && (
          <div className="flex flex-col gap-3">
            {oauthMethods.map((m) => (
              <Button key={m.id} type="button" onClick={() => handleOAuth(m.id)} fullWidth>
                Sign in with {m.label}
              </Button>
            ))}
          </div>
        )}

        {oauthMethods.length > 0 && localMethod && (
          <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-sh-gray/60">
            <span className="h-px flex-1 bg-sh-gray/20" />
            or
            <span className="h-px flex-1 bg-sh-gray/20" />
          </div>
        )}

        {localMethod && (
          <form onSubmit={handleLocalSubmit} className="flex flex-col gap-3">
            <div>
              <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-sh-navy">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-[44px] w-full rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="mb-1 block text-sm font-medium text-sh-navy"
              >
                Password
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-h-[44px] w-full rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" fullWidth disabled={submitting}>
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
            <p className="text-center text-sm">
              <Link
                href="/auth/forgot-password"
                className="text-sh-gray hover:text-sh-navy hover:underline"
              >
                Forgot password?
              </Link>
            </p>
          </form>
        )}
      </div>

      {PRODUCT.attribution ? (
        <a
          href={PRODUCT.makerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-sh-gray/70 transition-colors hover:text-sh-gray"
        >
          {PRODUCT.attribution}
        </a>
      ) : null}
    </div>
  );
}
