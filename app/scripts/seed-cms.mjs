// app/scripts/seed-cms.mjs
//
// Seeds example CMS content (home page, about page, two blog posts, header and
// footer menus) for the default organization so a fresh deployment has a real
// public site to start from. Idempotent: upserts by (organizationId, slug) and
// (organizationId, location). Safe to re-run.
//
// Usage (from app/):  node scripts/seed-cms.mjs
// Requires DATABASE_URL in the environment (or load app/.env.local first).

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const ORG_ID = 1;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Load app/.env.local before running.");
    process.exit(1);
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const settings = await prisma.appSettings.findUnique({ where: { organizationId: ORG_ID } });
    const appName = settings?.appName ?? "Holt";
    const tagline = settings?.tagline ?? "Considered furniture for considered homes.";
    const now = new Date();

    const homeBlocks = [
      {
        id: "home-hero",
        type: "hero",
        heading: "Run your whole store from one platform",
        subheading:
          "Point of sale, inventory, purchasing, delivery, consignment, and a built-in storefront — purpose-built for furniture and home-goods retailers. Own your data, customize everything, no lock-in.",
        imageUrl: "",
        ctaLabel: "Get started",
        ctaHref: "/app",
        align: "center",
      },
      {
        id: "home-features",
        type: "features",
        heading: "Everything your store runs on",
        subheading: "One system replaces the patchwork of POS, spreadsheets, and bolt-on tools.",
        items: [
          {
            title: "Point of Sale",
            body: "Fast counter sales, tills, gift cards, and Stripe payments — with receipts, returns, and registers built in.",
          },
          {
            title: "Catalog & Pricing",
            body: "Multi-dimensional vendor pricing (grades, species, multi-axis) with PDF price-book import and a live configurator.",
          },
          {
            title: "Inventory & Barcode",
            body: "Real-time stock by location, barcode scanning, transfers, and physical counts that reconcile automatically.",
          },
          {
            title: "Purchasing & Receiving",
            body: "Purchase orders, inbound tracking, and receiving that keeps stock and the ledger in sync.",
          },
          {
            title: "Delivery & Dispatch",
            body: "Zone-based delivery planning, route building, and a drag-and-drop dispatch board.",
          },
          {
            title: "Consignment",
            body: "Track consigned goods, vendor payouts, and returns end to end — not an afterthought.",
          },
          {
            title: "Customer Intelligence",
            body: "Customer leveling, lead scoring, and life-event signals so you focus on the buyers who matter.",
          },
          {
            title: "Reporting & Accounting",
            body: "Sales, commission, tax, and a full general ledger — the numbers you trust, in real time.",
          },
          {
            title: "Storefront & CMS",
            body: "A themeable public website and blog you edit in-app — with optional ecommerce when you are ready.",
          },
        ],
      },
      {
        id: "home-stats",
        type: "stats",
        items: [
          { value: "All-in-one", label: "POS + ERP + storefront" },
          { value: "Own it", label: "Export your data anytime" },
          { value: "White-label", label: "Your brand, your domain" },
          { value: "Open-core", label: "No vendor lock-in" },
        ],
      },
      {
        id: "home-cta",
        type: "cta",
        heading: "See it running",
        body: "Sign in to explore the back office — or just look around this site. It is built and edited entirely in the platform.",
        buttonLabel: "Sign in",
        buttonHref: "/app",
      },
    ];

    const aboutBlocks = [
      {
        id: "about-hero",
        type: "hero",
        heading: "One platform. Built by operators, owned by you.",
        subheading:
          "Most stores run on a dozen disconnected tools nobody fully controls. This is the opposite: a single system for the whole operation, on a modern stack, with your data exportable any day you ask.",
        imageUrl: "",
        ctaLabel: "Get started",
        ctaHref: "/app",
        ctaLabel2: "Read the journal",
        ctaHref2: "/blog",
        align: "center",
      },
      {
        id: "about-stats",
        type: "stats",
        items: [
          { value: "20+ yrs", label: "of retail operations behind it" },
          { value: "9", label: "modules, one login" },
          { value: "1", label: "platform to run on" },
          { value: "100%", label: "your data, exportable" },
        ],
      },
      {
        id: "about-idea",
        type: "richText",
        html: "<h2>The idea</h2><p>Software you own beats software you rent. Every part of this platform &mdash; the catalog, the register, the storefront you are reading now &mdash; is configured from inside the app and backed by data you can export whenever you want. No black boxes, no lock-in, no waiting on a vendor to make a change.</p>",
      },
      {
        id: "about-how",
        type: "features",
        heading: "How it works",
        subheading: "From first login to running your floor, the path is short.",
        items: [
          {
            title: "1 — Onboard",
            body: "Import your catalog, customers, and history. Brand it with your name, logo, and colors in minutes.",
          },
          {
            title: "2 — Run",
            body: "Sell at the register, receive POs, schedule deliveries, and track inventory in real time.",
          },
          {
            title: "3 — Grow",
            body: "Lean on reporting, lead scoring, and customer intelligence to put effort where it pays.",
          },
          {
            title: "4 — Own",
            body: "Your storefront, your data, your rules. Export everything any time — the door is always open.",
          },
        ],
      },
      {
        id: "about-quote",
        type: "quote",
        quote: "Build technology small businesses own. No rent-seeking, no lock-in, no black boxes.",
        attribution: "The Akritos principle",
      },
      {
        id: "about-principles",
        type: "features",
        heading: "What we hold to",
        items: [
          {
            title: "Own your data",
            body: "One-click export of customers, products, orders, and inventory. It is yours, always.",
          },
          {
            title: "One platform",
            body: "POS, ERP, and storefront in a single system — not a patchwork billed separately.",
          },
          {
            title: "Built by operators",
            body: "Shaped by years of running a real store, not a whiteboard feature list.",
          },
          {
            title: "No lock-in",
            body: "Open-core and self-hostable. Stay because it is good, not because you are trapped.",
          },
        ],
      },
      {
        id: "about-cta",
        type: "cta",
        heading: "Ready to see it?",
        body: "Sign in to explore the back office, or keep browsing — this whole site is built in the platform.",
        buttonLabel: "Sign in",
        buttonHref: "/app",
      },
    ];

    await prisma.page.upsert({
      where: { organizationId_slug: { organizationId: ORG_ID, slug: "home" } },
      update: { title: "Home", blocks: homeBlocks, status: "PUBLISHED", isHome: true, publishedAt: now },
      create: {
        organizationId: ORG_ID,
        slug: "home",
        title: "Home",
        blocks: homeBlocks,
        status: "PUBLISHED",
        isHome: true,
        publishedAt: now,
        createdBy: "seed",
      },
    });

    await prisma.page.upsert({
      where: { organizationId_slug: { organizationId: ORG_ID, slug: "about" } },
      update: { title: "About", blocks: aboutBlocks, status: "PUBLISHED", publishedAt: now },
      create: {
        organizationId: ORG_ID,
        slug: "about",
        title: "About",
        blocks: aboutBlocks,
        status: "PUBLISHED",
        publishedAt: now,
        createdBy: "seed",
      },
    });

    const posts = [
      {
        slug: "welcome-to-the-journal",
        title: "Welcome to the journal",
        excerpt: "How we think about content, commerce, and craft in one platform.",
        html: "<p>This is an example post. Posts share the same block editor as pages and appear on the public blog index.</p>",
      },
      {
        slug: "designing-for-every-room",
        title: "Designing for every room",
        excerpt: "A short note on putting the catalog to work.",
        html: "<p>Replace this with your own writing from Admin &rarr; CMS &rarr; Posts.</p>",
      },
    ];

    for (const post of posts) {
      const blocks = [{ id: `${post.slug}-body`, type: "richText", html: post.html }];
      await prisma.post.upsert({
        where: { organizationId_slug: { organizationId: ORG_ID, slug: post.slug } },
        update: { title: post.title, excerpt: post.excerpt, blocks, status: "PUBLISHED", publishedAt: now },
        create: {
          organizationId: ORG_ID,
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt,
          blocks,
          status: "PUBLISHED",
          publishedAt: now,
          author: "Editorial",
          createdBy: "seed",
        },
      });
    }

    await prisma.menu.upsert({
      where: { organizationId_location: { organizationId: ORG_ID, location: "header" } },
      update: {
        items: [
          { label: "Home", href: "/", children: [] },
          { label: "Journal", href: "/blog", children: [] },
          { label: "About", href: "/about", children: [] },
          { label: "Book", href: "/book", children: [] },
        ],
      },
      create: {
        organizationId: ORG_ID,
        location: "header",
        items: [
          { label: "Home", href: "/", children: [] },
          { label: "Journal", href: "/blog", children: [] },
          { label: "About", href: "/about", children: [] },
          { label: "Book", href: "/book", children: [] },
        ],
        createdBy: "seed",
      },
    });

    await prisma.menu.upsert({
      where: { organizationId_location: { organizationId: ORG_ID, location: "footer" } },
      update: {
        items: [
          { label: "About", href: "/about", children: [] },
          { label: "Journal", href: "/blog", children: [] },
          { label: "Staff sign in", href: "/app", children: [] },
        ],
      },
      create: {
        organizationId: ORG_ID,
        location: "footer",
        items: [
          { label: "About", href: "/about", children: [] },
          { label: "Journal", href: "/blog", children: [] },
          { label: "Staff sign in", href: "/app", children: [] },
        ],
        createdBy: "seed",
      },
    });

    console.log("Seeded CMS example content (home, about, 2 posts, header + footer menus).");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
