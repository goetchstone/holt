// /app/__tests__/fuzz/cmsSanitize.fuzz.test.ts
//
// Property-based fuzzing of lib/cms/sanitize.ts, which cleans CMS author HTML
// before the PUBLIC site renders it. Generated markup mixes allowed and
// forbidden tags, event handlers, and every URL-scheme disguise (case, entity
// encoding, embedded whitespace) with random text. The sanitized output is
// then re-parsed and every surviving tag and attribute is checked against the
// policy the module documents: allowlisted tags only, no on* handlers, no
// script-capable URL scheme, iframes only from the embed allowlist, and every
// link carrying rel="noopener noreferrer".

import fc from "fast-check";
import sanitizeHtml from "sanitize-html";
import { sanitizeCmsHtml } from "@/lib/cms/sanitize";
import { anyString } from "./support";

const ALLOWED_TAGS = new Set(
  "h1 h2 h3 h4 h5 h6 p span div blockquote pre code ul ol li strong em b i u s a br hr img figure figcaption table thead tbody tr th td iframe".split(
    " ",
  ),
);
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "frameborder", "loading"],
};
const IFRAME_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.google.com",
  "maps.google.com",
  "www.loom.com",
]);

// ── Generator: hostile HTML ──────────────────────────────────────────────────

// Weighted toward the tags that carry URLs, where the policy actually bites.
const tagName = fc.oneof(
  { arbitrary: fc.constantFrom("a", "img", "iframe", "IfRaMe", "A"), weight: 3 },
  { arbitrary: fc.constantFrom(...ALLOWED_TAGS), weight: 2 },
  {
    arbitrary: fc.constantFrom(
      "script",
      "style",
      "svg",
      "math",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "meta",
      "link",
      "base",
      "noscript",
      "template",
      "textarea",
      "title",
      "SCRIPT",
    ),
    weight: 2,
  },
);
const url = fc.oneof(
  fc.constantFrom(
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    " javascript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "javascript&colon;alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/png;base64,AAAA",
    "https://www.youtube.com/embed/x",
    "https://evil.example/embed",
    "//evil.example/x",
    "https://www.youtube.com.evil.example/x",
    "https://evil.example\\@www.youtube.com/",
    "mailto:a@example.com",
    "tel:+15555550100",
    "/relative/path",
    "#anchor",
  ),
  anyString(15),
);
const attr = fc.oneof(
  { arbitrary: fc.tuple(fc.constantFrom("href", "src", "HREF", "SRC"), url), weight: 3 },
  {
    arbitrary: fc.tuple(fc.constantFrom("srcdoc", "formaction", "xlink:href", "action"), url),
    weight: 1,
  },
  {
    arbitrary: fc.tuple(
      fc.constantFrom("onerror", "onclick", "ONLOAD", "onmouseover", "style"),
      fc.constantFrom("alert(1)", "x:expression(alert(1))"),
    ),
    weight: 1,
  },
  {
    arbitrary: fc.tuple(
      fc.constantFrom("class", "title", "alt", "rel", "target", "name", "width"),
      anyString(10),
    ),
    weight: 1,
  },
);
const quote = fc.constantFrom('"', "'", "");
const attrText = fc
  .tuple(attr, quote)
  .map(
    ([[name, value], q]) =>
      ` ${name}=${q}${q ? value.split(q).join("") : value.replace(/[\s>]/g, "")}${q}`,
  );

const htmlNode: fc.Arbitrary<string> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    { arbitrary: anyString(20), weight: 1 },
    {
      arbitrary: fc.constantFrom(
        "<!-- c -->",
        "<![CDATA[x]]>",
        "&lt;script&gt;",
        "<",
        ">",
        "</",
        "<img src=x onerror=alert(1)>",
      ),
      weight: 1,
    },
    {
      arbitrary: fc
        .tuple(
          tagName,
          fc.array(attrText, { maxLength: 3 }),
          fc.array(tie("node"), { maxLength: 3 }),
          fc.boolean(),
        )
        .map(
          ([t, attrs, children, close]) =>
            `<${t}${attrs.join("")}>${children.join("")}${close ? `</${t}>` : ""}`,
        ),
      weight: 3,
    },
  ),
})).node;
const html = fc.array(htmlNode, { maxLength: 6 }).map((nodes) => nodes.join(""));

// ── Oracle: re-parse the output and inspect every surviving tag ─────────────

function openTags(output: string): Array<[string, Record<string, string>]> {
  const seen: Array<[string, Record<string, string>]> = [];
  // Parse only: allow everything through and record each tag as parsed.
  sanitizeHtml(output, {
    allowedTags: false,
    allowedAttributes: false,
    onOpenTag: (name, attribs) => {
      seen.push([name, { ...attribs }]);
    },
  });
  return seen;
}

function scheme(value: string): string | null {
  // Browsers ignore ASCII whitespace and controls inside a URL's scheme.
  const compact = value.replace(/[\u0000- ]/g, "").toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  return m ? m[1] : null;
}

describe("sanitizeCmsHtml (lib/cms/sanitize.ts)", () => {
  it("leaves only allowlisted tags, attributes, schemes and iframe hosts", () => {
    fc.assert(
      fc.property(html, (input) => {
        const output = sanitizeCmsHtml(input);
        for (const [tag, attribs] of openTags(output)) {
          expect(ALLOWED_TAGS.has(tag)).toBe(true);
          for (const [name, value] of Object.entries(attribs)) {
            expect(name.startsWith("on")).toBe(false);
            expect(name === "class" || (ALLOWED_ATTRS[tag] ?? []).includes(name)).toBe(true);
            if (name === "href" || name === "src") {
              const s = scheme(value);
              const allowed =
                tag === "img" ? ["http", "https", "data"] : ["http", "https", "mailto", "tel"];
              if (s !== null) expect(allowed).toContain(s);
            }
          }
          if (tag === "iframe" && attribs.src !== undefined) {
            expect(
              IFRAME_HOSTS.has(new URL(attribs.src, "https://relative.invalid").hostname),
            ).toBe(true);
          }
          if (tag === "a") expect(attribs.rel).toBe("noopener noreferrer");
        }
      }),
    );
  });
});
