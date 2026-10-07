// /app/src/components/branding/BrandingProvider.tsx
//
// Makes the org's display branding (name, logos) available to client chrome
// without each component fetching it. The value is resolved server-side and
// passed down through pageProps (see lib/auth/withAuth.ts), so first paint is
// already branded -- no flash from a default to the tenant's identity.

import { createContext, useContext, useCallback, type ReactNode } from "react";
import { DEFAULT_BRANDING, type Branding } from "@/lib/branding";
import { formatMoney, type LocaleConfig } from "@/lib/formatMoney";

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

export function BrandingProvider({
  value,
  children,
}: {
  value?: Branding | null;
  children: ReactNode;
}) {
  return (
    <BrandingContext.Provider value={value ?? DEFAULT_BRANDING}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}

/**
 * The tenant's locale/currency/timezone for display formatting. Reads from the
 * same branding payload (resolved server-side, injected via pageProps) so
 * formatMoney/formatDate render in the org's configured locale without each
 * call site fetching settings.
 */
export function useLocale(): LocaleConfig {
  const b = useContext(BrandingContext);
  return { locale: b.locale, currency: b.currency, timezone: b.timezone };
}

/**
 * Returns a currency formatter bound to the tenant's locale + currency. Lets a
 * component drop in `const fmt = useMoneyFormatter();` and keep every existing
 * `fmt(value)` call site unchanged, instead of threading locale through props.
 * Pass { whole: true } at a call site to drop the cents.
 */
export function useMoneyFormatter(): (
  value: number | null | undefined,
  opts?: { whole?: boolean },
) => string {
  const b = useContext(BrandingContext);
  return useCallback(
    (value, opts) =>
      formatMoney(value, { currency: b.currency, locale: b.locale, whole: opts?.whole }),
    [b.currency, b.locale],
  );
}
