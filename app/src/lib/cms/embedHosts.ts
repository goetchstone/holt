// /app/src/lib/cms/embedHosts.ts
//
// The providers a CMS embed block may frame: one home (CLAUDE.md rule 6) for
// two readers. The sanitizer (lib/cms/sanitize.ts) drops an iframe from any
// other host, and the Content-Security-Policy (lib/contentSecurityPolicy.ts)
// names these hosts in frame-src so the browser loads the frames the sanitizer
// kept. Before they shared this list, the policy blocked every embed the
// sanitizer admitted, and embed blocks rendered empty.
//
// Its own module, not an export of sanitize.ts, so src/proxy.ts, which builds
// the policy on every page request, does not pull in sanitize-html.

/** Hostnames an embed block's iframe may load from. */
export const CMS_EMBED_HOSTNAMES = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.google.com",
  "maps.google.com",
  "www.loom.com",
] as const;
