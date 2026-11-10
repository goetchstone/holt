// /app/src/components/help/helpProse.ts
//
// How a help article's HTML looks, in the panel and on its own page alike.

export const HELP_PROSE = [
  "text-brand-black",
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:font-serif [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-brand-blue",
  "[&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:font-semibold",
  "[&_p]:my-2 [&_p]:leading-relaxed",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_a]:text-brand-blue [&_a]:underline",
  "[&_code]:rounded [&_code]:bg-brand-stripe [&_code]:px-1",
  "[&_blockquote]:border-l-4 [&_blockquote]:border-brand-gold [&_blockquote]:pl-3",
].join(" ");
