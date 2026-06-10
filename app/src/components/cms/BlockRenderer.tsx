// /app/src/components/cms/BlockRenderer.tsx
//
// Renders CMS content blocks (see lib/cms/blocks.ts) to React for the public
// site. Server component -- no client state. Author HTML (richText/embed) is
// sanitized (lib/cms/sanitize.ts). Visual treatment tuned to akritos-grade
// design (full-height hero, py-24 section rhythm, 1200px containers, 2px buttons,
// 56px/28px type scale) -- generic so every tenant benefits; brand colors come
// from the sh-* theme tokens. Section blocks support a `background` variant
// (default / muted / dark) so a page alternates light + dark bands, and an
// `eyebrow` label (small gold uppercase tag above the heading) -- both are
// per-block config, set in the admin editor and seeded per tenant.

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import type { ContentBlock } from "@/lib/cms/blocks";
import { sanitizeCmsHtml } from "@/lib/cms/sanitize";

const ALIGN_CLASS = {
  left: "text-left items-start",
  center: "text-center items-center",
  right: "text-right items-end",
} as const;

// Shared section container: akritos uses a 1200px hard limit + 24px gutters.
const CONTAINER = "mx-auto w-full max-w-[1200px] px-6";
const SECTION_PAD = "py-24";

// Background variant -> coordinated background + text colors. Keeping the full
// class strings literal here (not built by interpolation) so Tailwind's content
// scanner picks every one of them up.
const SECTION_THEME = {
  default: {
    section: "",
    heading: "text-sh-navy",
    sub: "text-sh-gray",
    body: "text-sh-gray",
    card: "border-black/10 bg-white",
    eyebrow: "text-sh-gold",
  },
  muted: {
    section: "bg-sh-linen",
    heading: "text-sh-navy",
    sub: "text-sh-gray",
    body: "text-sh-gray",
    card: "border-black/10 bg-white",
    eyebrow: "text-sh-gold",
  },
  dark: {
    section: "bg-sh-navy text-white",
    heading: "text-white",
    sub: "text-white/80",
    body: "text-white/80",
    card: "border-white/15 bg-white/5",
    eyebrow: "text-sh-gold",
  },
} as const;

function Eyebrow({ text, className }: { text: string; className: string }) {
  if (!text) return null;
  return (
    <p className={`mb-3 text-xs font-semibold uppercase tracking-[0.18em] ${className}`}>{text}</p>
  );
}

function HeroBlockView({ block }: { block: Extract<ContentBlock, { type: "hero" }> }) {
  return (
    <section
      className="relative flex min-h-screen flex-col justify-center bg-sh-navy bg-cover bg-center px-6 pb-24 pt-32 text-white"
      style={block.imageUrl ? { backgroundImage: `url(${block.imageUrl})` } : undefined}
    >
      {block.imageUrl ? <div className="absolute inset-0 bg-black/40" aria-hidden /> : null}
      <div
        className={`relative mx-auto flex w-full max-w-[1200px] flex-col ${ALIGN_CLASS[block.align]}`}
      >
        {block.markUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- CMS brand mark is an arbitrary URL
          <img src={block.markUrl} alt="" aria-hidden className="mb-6 h-12 w-auto" />
        ) : null}
        {block.eyebrow ? (
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.15em] text-sh-gold">
            {block.eyebrow}
          </p>
        ) : null}
        {block.heading ? (
          <h1 className="font-serif text-4xl leading-tight sm:text-5xl lg:text-[56px]">
            {block.heading}
            {block.headingAccent ? (
              <span className="block text-sh-gold">{block.headingAccent}</span>
            ) : null}
          </h1>
        ) : null}
        {block.subheading ? (
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/85">{block.subheading}</p>
        ) : null}
        {(block.ctaLabel && block.ctaHref) || (block.ctaLabel2 && block.ctaHref2) ? (
          <div className="mt-8 flex flex-wrap gap-3">
            {block.ctaLabel && block.ctaHref ? (
              <Link
                href={block.ctaHref}
                className="inline-flex items-center gap-2 rounded-[2px] bg-sh-gold px-6 py-3 text-sm font-medium text-sh-navy transition hover:opacity-90"
              >
                {block.ctaLabel} <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
            {block.ctaLabel2 && block.ctaHref2 ? (
              <Link
                href={block.ctaHref2}
                className="inline-block rounded-[2px] border border-white/30 px-6 py-3 text-sm font-medium text-white transition hover:border-sh-gold hover:text-sh-gold"
              >
                {block.ctaLabel2}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ImageBlockView({ block }: { block: Extract<ContentBlock, { type: "image" }> }) {
  if (!block.url) return null;
  return (
    <figure className={`${CONTAINER} py-12`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- CMS images are arbitrary external URLs */}
      <img src={block.url} alt={block.alt} className="mx-auto h-auto w-full rounded-md" />
      {block.caption ? (
        <figcaption className="mt-2 text-center text-sm text-sh-gray">{block.caption}</figcaption>
      ) : null}
    </figure>
  );
}

function GalleryBlockView({ block }: { block: Extract<ContentBlock, { type: "gallery" }> }) {
  if (block.images.length === 0) return null;
  return (
    <div className={`grid ${CONTAINER} grid-cols-2 gap-4 py-12 sm:grid-cols-3`}>
      {block.images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- CMS images are arbitrary external URLs
        <img key={i} src={img.url} alt={img.alt} className="h-48 w-full rounded-md object-cover" />
      ))}
    </div>
  );
}

function CtaBlockView({ block }: { block: Extract<ContentBlock, { type: "cta" }> }) {
  const t = SECTION_THEME[block.background];
  // Navy button reads well on light bands; on a dark band use the gold accent.
  const button =
    block.background === "dark"
      ? "bg-sh-gold text-sh-navy hover:opacity-90"
      : "bg-sh-navy text-white hover:bg-sh-blue";
  return (
    <section className={`px-6 text-center ${SECTION_PAD} ${t.section}`}>
      <div className="mx-auto max-w-screen-md">
        <Eyebrow text={block.eyebrow} className={t.eyebrow} />
        {block.heading ? (
          <h2 className={`font-serif text-[28px] ${t.heading}`}>{block.heading}</h2>
        ) : null}
        {block.body ? <p className={`mt-3 ${t.body}`}>{block.body}</p> : null}
        {block.buttonLabel && block.buttonHref ? (
          <Link
            href={block.buttonHref}
            className={`mt-6 inline-block rounded-[2px] px-6 py-3 text-sm font-medium transition ${button}`}
          >
            {block.buttonLabel}
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function FeaturesBlockView({ block }: { block: Extract<ContentBlock, { type: "features" }> }) {
  if (block.items.length === 0 && !block.heading) return null;
  const t = SECTION_THEME[block.background];
  return (
    <section className={`px-6 ${SECTION_PAD} ${t.section}`}>
      <div className="mx-auto w-full max-w-[1200px]">
        {block.eyebrow ? (
          <div className="text-center">
            <Eyebrow text={block.eyebrow} className={t.eyebrow} />
          </div>
        ) : null}
        {block.heading ? (
          <h2 className={`text-center font-serif text-[28px] ${t.heading}`}>{block.heading}</h2>
        ) : null}
        {block.subheading ? (
          <p className={`mx-auto mt-3 max-w-2xl text-center ${t.sub}`}>{block.subheading}</p>
        ) : null}
        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {block.items.map((item, i) => (
            <div key={i} className={`rounded-lg border p-6 ${t.card}`}>
              <h3 className={`font-serif text-lg ${t.heading}`}>{item.title}</h3>
              <p className={`mt-2 text-sm leading-relaxed ${t.body}`}>{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StatsBlockView({ block }: { block: Extract<ContentBlock, { type: "stats" }> }) {
  if (block.items.length === 0) return null;
  const t = SECTION_THEME[block.background];

  // Checklist variant: one inline row of check-marked claims (a trust strip),
  // instead of the big-numbers grid.
  if (block.variant === "checklist") {
    return (
      <section className={`px-6 py-8 ${t.section}`}>
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {block.items.map((item, i) => (
            <span key={i} className={`inline-flex items-center gap-2 text-sm ${t.body}`}>
              <CheckCircle2 className="h-4 w-4 shrink-0 text-sh-gold" strokeWidth={1.5} />
              {item.value}
              {item.label ? <span className="opacity-60">— {item.label}</span> : null}
            </span>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={`px-6 ${SECTION_PAD} ${t.section}`}>
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-8 text-center sm:grid-cols-4">
        {block.items.map((item, i) => (
          <div key={i}>
            <div className="font-serif text-4xl text-sh-gold">{item.value}</div>
            <div className={`mt-1 text-sm ${t.body}`}>{item.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuoteBlockView({ block }: { block: Extract<ContentBlock, { type: "quote" }> }) {
  if (!block.quote) return null;
  const t = SECTION_THEME[block.background];
  return (
    <section className={`px-6 ${SECTION_PAD} ${t.section}`}>
      <figure className="mx-auto max-w-screen-md text-center">
        <Eyebrow text={block.eyebrow} className={t.eyebrow} />
        <blockquote className={`font-serif text-[28px] leading-relaxed ${t.heading}`}>
          &ldquo;{block.quote}&rdquo;
        </blockquote>
        {block.attribution ? (
          <figcaption className={`mt-4 text-sm uppercase tracking-wide ${t.body}`}>
            {block.attribution}
          </figcaption>
        ) : null}
      </figure>
    </section>
  );
}

function renderBlock(block: ContentBlock) {
  switch (block.type) {
    case "hero":
      return <HeroBlockView key={block.id} block={block} />;
    case "features":
      return <FeaturesBlockView key={block.id} block={block} />;
    case "stats":
      return <StatsBlockView key={block.id} block={block} />;
    case "quote":
      return <QuoteBlockView key={block.id} block={block} />;
    case "richText":
      return (
        <section key={block.id} className={SECTION_THEME[block.background].section}>
          <div
            className={`prose mx-auto max-w-screen-md px-6 py-12 ${
              block.background === "dark"
                ? "prose-invert text-sh-stripe/70 prose-a:text-sh-gold"
                : "text-sh-black"
            }`}
            dangerouslySetInnerHTML={{ __html: sanitizeCmsHtml(block.html) }}
          />
        </section>
      );
    case "image":
      return <ImageBlockView key={block.id} block={block} />;
    case "gallery":
      return <GalleryBlockView key={block.id} block={block} />;
    case "cta":
      return <CtaBlockView key={block.id} block={block} />;
    case "embed":
      return (
        <div
          key={block.id}
          className={`${CONTAINER} py-12`}
          dangerouslySetInnerHTML={{ __html: sanitizeCmsHtml(block.html) }}
        />
      );
  }
}

export function BlockRenderer({ blocks }: { blocks: ContentBlock[] }) {
  return <>{blocks.map((block) => renderBlock(block))}</>;
}
