// app/scripts/sitemap-diff.mjs
//
// SEO-preservation check for the Akritos cutover: every URL on the LIVE
// site's sitemap must resolve on the Holt deployment at the same path —
// same slugs in, same slugs out, or indexed authority is lost.
//
// Usage:
//   node scripts/sitemap-diff.mjs https://akritos.com http://localhost:3000
//
// Compares the two /sitemap.xml path sets, then HEAD-checks every live path
// against the candidate base so a slug that exists in the sitemap but 404s
// in practice is caught too. Exit code 1 when anything is missing.

const [liveBase, candidateBase] = process.argv.slice(2);
if (!liveBase || !candidateBase) {
  console.error("Usage: node scripts/sitemap-diff.mjs <live-base-url> <candidate-base-url>");
  process.exit(1);
}

async function sitemapPaths(base) {
  const res = await fetch(`${base.replace(/\/$/, "")}/sitemap.xml`);
  if (!res.ok) throw new Error(`${base}/sitemap.xml -> HTTP ${res.status}`);
  const xml = await res.text();
  const paths = new Set();
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    try {
      paths.add(new URL(m[1]).pathname.replace(/\/$/, "") || "/");
    } catch {
      console.warn(`  skipping unparseable <loc>: ${m[1]}`);
    }
  }
  return paths;
}

async function headOk(base, p) {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${p}`, { method: "GET", redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

const live = await sitemapPaths(liveBase);
const candidate = await sitemapPaths(candidateBase);

const missingFromSitemap = [...live].filter((p) => !candidate.has(p)).sort();
const extra = [...candidate].filter((p) => !live.has(p)).sort();

console.log(`Live sitemap: ${live.size} paths. Candidate sitemap: ${candidate.size} paths.`);
if (missingFromSitemap.length > 0) {
  console.log(`\nMISSING from candidate sitemap (${missingFromSitemap.length}):`);
  for (const p of missingFromSitemap) console.log(`  ${p}`);
}
if (extra.length > 0) {
  console.log(`\nExtra in candidate (fine, just informational) (${extra.length}):`);
  for (const p of extra) console.log(`  ${p}`);
}

console.log("\nResolving every live path against the candidate...");
const broken = [];
for (const p of [...live].sort()) {
  if (!(await headOk(candidateBase, p))) broken.push(p);
}
if (broken.length > 0) {
  console.log(`\nBROKEN on candidate (${broken.length}):`);
  for (const p of broken) console.log(`  ${p}`);
}

if (missingFromSitemap.length === 0 && broken.length === 0) {
  console.log("\nAll live URLs are present and resolve on the candidate. SEO parity holds.");
} else {
  process.exitCode = 1;
}
