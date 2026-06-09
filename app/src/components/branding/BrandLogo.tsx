// /app/src/components/branding/BrandLogo.tsx
//
// Renders the deployment's configured logo image, or the app-name wordmark when
// no logo URL is set. No tenant logo is bundled with the product, so the
// white-label default is always the configured name -- never another client's
// brand. Used by the login page and every nav/layout header.

interface BrandLogoProps {
  appName: string;
  /** Configured logo URL (AppSettings.logoUrl / loginLogoUrl). Null -> wordmark. */
  logoUrl?: string | null;
  /** Classes applied to the <img> when a logo URL is set. */
  className?: string;
  width?: number;
  height?: number;
  /** Classes for the text wordmark fallback. */
  wordmarkClassName?: string;
}

export function BrandLogo({
  appName,
  logoUrl,
  className,
  width,
  height,
  wordmarkClassName = "font-serif text-2xl font-semibold text-sh-navy",
}: BrandLogoProps) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- configurable brand logo URL
      <img src={logoUrl} alt={appName} width={width} height={height} className={className} />
    );
  }
  return <span className={wordmarkClassName}>{appName}</span>;
}
