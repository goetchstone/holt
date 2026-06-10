// /app/src/components/cms/admin/BlockFields.tsx
//
// Per-block-type field editors for the BlockEditor. Each block kind gets a
// small focused component so no single function carries all the form logic.

"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  ALIGNMENTS,
  SECTION_BACKGROUNDS,
  type ContentBlock,
  type SectionBackground,
} from "@/lib/cms/blocks";
import { ImageUploadField } from "./ImageUploadField";

type Patch = Partial<ContentBlock>;

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-sh-gray">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-sh-gray">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-black/15 px-3 py-2 font-mono text-sm focus:border-sh-navy focus:outline-none"
      />
    </label>
  );
}

function BackgroundField({
  value,
  onChange,
}: {
  value: SectionBackground;
  onChange: (v: SectionBackground) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-sh-gray">Background</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SectionBackground)}
        className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
      >
        {SECTION_BACKGROUNDS.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BlockFields({
  block,
  onPatch,
}: {
  block: ContentBlock;
  onPatch: (patch: Patch) => void;
}) {
  switch (block.type) {
    case "hero":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Eyebrow (small gold caps, optional)"
            value={block.eyebrow}
            onChange={(v) => onPatch({ eyebrow: v })}
          />
          <TextField
            label="Heading"
            value={block.heading}
            onChange={(v) => onPatch({ heading: v })}
          />
          <TextField
            label="Heading accent line (gold, optional)"
            value={block.headingAccent}
            onChange={(v) => onPatch({ headingAccent: v })}
          />
          <TextField
            label="Subheading"
            value={block.subheading}
            onChange={(v) => onPatch({ subheading: v })}
          />
          <ImageUploadField
            label="Brand mark URL (small, above heading)"
            value={block.markUrl}
            onChange={(v) => onPatch({ markUrl: v })}
          />
          <ImageUploadField
            label="Background image URL"
            value={block.imageUrl}
            onChange={(v) => onPatch({ imageUrl: v })}
          />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Alignment</span>
            <select
              value={block.align}
              onChange={(e) => onPatch({ align: e.target.value as (typeof ALIGNMENTS)[number] })}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            >
              {ALIGNMENTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Button label"
            value={block.ctaLabel}
            onChange={(v) => onPatch({ ctaLabel: v })}
          />
          <TextField
            label="Button link"
            value={block.ctaHref}
            onChange={(v) => onPatch({ ctaHref: v })}
            placeholder="/about or https://..."
          />
          <TextField
            label="Secondary button label (optional)"
            value={block.ctaLabel2}
            onChange={(v) => onPatch({ ctaLabel2: v })}
          />
          <TextField
            label="Secondary button link"
            value={block.ctaHref2}
            onChange={(v) => onPatch({ ctaHref2: v })}
            placeholder="/contact or https://..."
          />
        </div>
      );
    case "features":
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Eyebrow (small label above heading)"
              value={block.eyebrow}
              onChange={(v) => onPatch({ eyebrow: v })}
            />
            <BackgroundField
              value={block.background}
              onChange={(v) => onPatch({ background: v })}
            />
          </div>
          <TextField
            label="Section heading"
            value={block.heading}
            onChange={(v) => onPatch({ heading: v })}
          />
          <TextField
            label="Section subheading"
            value={block.subheading}
            onChange={(v) => onPatch({ subheading: v })}
          />
          {block.items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border border-black/10 p-2">
              <div className="grid flex-1 gap-2">
                <TextField
                  label={`Feature ${i + 1} title`}
                  value={item.title}
                  onChange={(v) =>
                    onPatch({
                      items: block.items.map((f, j) => (j === i ? { ...f, title: v } : f)),
                    })
                  }
                />
                <TextArea
                  label="Description"
                  value={item.body}
                  rows={2}
                  onChange={(v) =>
                    onPatch({
                      items: block.items.map((f, j) => (j === i ? { ...f, body: v } : f)),
                    })
                  }
                />
              </div>
              <button
                type="button"
                aria-label="Remove feature"
                onClick={() => onPatch({ items: block.items.filter((_, j) => j !== i) })}
                className="mt-6 text-sh-gray hover:text-red-600"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onPatch({ items: [...block.items, { title: "", body: "" }] })}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-sh-navy/30 px-3 py-1.5 text-sm text-sh-navy hover:bg-sh-linen"
          >
            <Plus size={14} /> Add feature
          </button>
        </div>
      );
    case "stats":
      return (
        <div className="flex flex-col gap-2">
          <BackgroundField value={block.background} onChange={(v) => onPatch({ background: v })} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Layout</span>
            <select
              value={block.variant}
              onChange={(e) => onPatch({ variant: e.target.value as "stats" | "checklist" })}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            >
              <option value="stats">Stats (big numbers grid)</option>
              <option value="checklist">Checklist (inline trust strip)</option>
            </select>
          </label>
          {block.items.map((item, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="grid flex-1 gap-2 sm:grid-cols-2">
                <TextField
                  label={`Stat ${i + 1} value`}
                  value={item.value}
                  onChange={(v) =>
                    onPatch({
                      items: block.items.map((s, j) => (j === i ? { ...s, value: v } : s)),
                    })
                  }
                />
                <TextField
                  label="Label"
                  value={item.label}
                  onChange={(v) =>
                    onPatch({
                      items: block.items.map((s, j) => (j === i ? { ...s, label: v } : s)),
                    })
                  }
                />
              </div>
              <button
                type="button"
                aria-label="Remove stat"
                onClick={() => onPatch({ items: block.items.filter((_, j) => j !== i) })}
                className="mb-2 text-sh-gray hover:text-red-600"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onPatch({ items: [...block.items, { value: "", label: "" }] })}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-sh-navy/30 px-3 py-1.5 text-sm text-sh-navy hover:bg-sh-linen"
          >
            <Plus size={14} /> Add stat
          </button>
        </div>
      );
    case "quote":
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Eyebrow (small label above quote)"
              value={block.eyebrow}
              onChange={(v) => onPatch({ eyebrow: v })}
            />
            <BackgroundField
              value={block.background}
              onChange={(v) => onPatch({ background: v })}
            />
          </div>
          <TextArea
            label="Quote"
            value={block.quote}
            rows={3}
            onChange={(v) => onPatch({ quote: v })}
          />
          <TextField
            label="Attribution"
            value={block.attribution}
            onChange={(v) => onPatch({ attribution: v })}
          />
        </div>
      );
    case "richText":
      return (
        <div className="flex flex-col gap-3">
          <BackgroundField value={block.background} onChange={(v) => onPatch({ background: v })} />
          <TextArea
            label="HTML"
            value={block.html}
            rows={8}
            onChange={(v) => onPatch({ html: v })}
          />
        </div>
      );
    case "image":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <ImageUploadField
            label="Image URL"
            value={block.url}
            onChange={(v) => onPatch({ url: v })}
          />
          <TextField label="Alt text" value={block.alt} onChange={(v) => onPatch({ alt: v })} />
          <TextField
            label="Caption"
            value={block.caption}
            onChange={(v) => onPatch({ caption: v })}
          />
        </div>
      );
    case "gallery":
      return (
        <div className="flex flex-col gap-2">
          {block.images.map((img, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="grid flex-1 gap-2 sm:grid-cols-2">
                <ImageUploadField
                  label={`Image ${i + 1} URL`}
                  value={img.url}
                  onChange={(v) =>
                    onPatch({
                      images: block.images.map((g, j) => (j === i ? { ...g, url: v } : g)),
                    })
                  }
                />
                <TextField
                  label="Alt text"
                  value={img.alt}
                  onChange={(v) =>
                    onPatch({
                      images: block.images.map((g, j) => (j === i ? { ...g, alt: v } : g)),
                    })
                  }
                />
              </div>
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => onPatch({ images: block.images.filter((_, j) => j !== i) })}
                className="mb-2 text-sh-gray hover:text-red-600"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onPatch({ images: [...block.images, { url: "", alt: "" }] })}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-sh-navy/30 px-3 py-1.5 text-sm text-sh-navy hover:bg-sh-linen"
          >
            <Plus size={14} /> Add image
          </button>
        </div>
      );
    case "cta":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Eyebrow (small label above heading)"
            value={block.eyebrow}
            onChange={(v) => onPatch({ eyebrow: v })}
          />
          <BackgroundField value={block.background} onChange={(v) => onPatch({ background: v })} />
          <TextField
            label="Heading"
            value={block.heading}
            onChange={(v) => onPatch({ heading: v })}
          />
          <TextField
            label="Button label"
            value={block.buttonLabel}
            onChange={(v) => onPatch({ buttonLabel: v })}
          />
          <div className="sm:col-span-2">
            <TextArea
              label="Body"
              value={block.body}
              rows={2}
              onChange={(v) => onPatch({ body: v })}
            />
          </div>
          <TextField
            label="Button link"
            value={block.buttonHref}
            onChange={(v) => onPatch({ buttonHref: v })}
          />
        </div>
      );
    case "leadMagnet":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Heading"
            value={block.heading}
            onChange={(v) => onPatch({ heading: v })}
          />
          <BackgroundField value={block.background} onChange={(v) => onPatch({ background: v })} />
          <div className="sm:col-span-2">
            <TextArea
              label="Body"
              value={block.body}
              rows={2}
              onChange={(v) => onPatch({ body: v })}
            />
          </div>
          <TextField
            label="Button label"
            value={block.buttonLabel}
            onChange={(v) => onPatch({ buttonLabel: v })}
          />
          <TextField
            label="Email placeholder"
            value={block.emailPlaceholder}
            onChange={(v) => onPatch({ emailPlaceholder: v })}
          />
          <TextField
            label="Resource link (shown after signup)"
            value={block.resourceUrl}
            onChange={(v) => onPatch({ resourceUrl: v })}
          />
          <TextField
            label="Source tag (lands on the lead as lead-magnet:<tag>)"
            value={block.sourceTag}
            onChange={(v) => onPatch({ sourceTag: v })}
          />
        </div>
      );
    case "embed":
      return (
        <TextArea
          label="Embed HTML (iframe, etc.)"
          value={block.html}
          rows={5}
          onChange={(v) => onPatch({ html: v })}
        />
      );
  }
}
