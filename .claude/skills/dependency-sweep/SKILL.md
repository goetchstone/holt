---
name: dependency-sweep
description: Run before starting a merge train, after any package.json/lockfile change, or when osv-scanner/Dependabot flags something. Encodes the CVE playbook learned 2026-07 — npm ci verification, scoped overrides, suppression policy, sweep-before-train.
---

# Dependency Sweep

New CVE advisories publish continuously and can turn the security gate red
for reasons that have nothing to do with the PR you're trying to land. This
skill is the playbook for handling that without breaking the build or
hiding a real vulnerability.

## When to run this

- Before starting a merge train (landing a queue of PRs back to back) —
  rule 55. Sweep first, then rebase the train. Don't debug a red gate
  PR-by-PR when the cause is upstream and shared by all of them.
- Any time `package.json` or the lockfile changes.
- Any time Dependabot or `osv-scanner` flags a new advisory.
- At session start if it's been more than a few days since the last check
  (`.claude/hooks/session-start-check.sh` surfaces this).

## Step 1: Run the scan

```bash
cd app && npm run security:deps
```

This runs `osv-scanner` against `app/package-lock.json` with suppressions
from `osv-scanner.toml` applied.

## Step 2: For each NEW finding, decide the terminal state (rule 48)

Every finding is exactly one of:

1. **Fixed** — bump the package (prefer LTS/latest-stable, rule 5).
2. **Tripwire-tested** — not applicable to most CVEs, but if the fix
   requires a workaround, add a test pinning the workaround stays in place.
3. **Explicitly won't-fix with rationale** — add a suppression (Step 3).

Never silent-ignore. A finding that's "probably fine" without documented
reasoning is exactly the failure mode this skill exists to prevent.

## Step 3: Adding or renewing a suppression (rule 54)

`osv-scanner.toml` entries need an `ignoreUntil` date and a `reason` that
cites the artifact proving the claim — not a general assertion.

```toml
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = 2026-MM-DD
reason = "Specific claim, tied to a file/line/artifact you actually opened this session."
```

**On expiry, re-verify — don't just extend the date.** Open the artifact
the reason cites (the lockfile entry, the Dockerfile stage, the CDN
tarball) and confirm the claim is STILL true against the current tree
before renewing. A suppression's `reason` string is prose; nothing
validates it automatically, and a wrong claim quietly written once gets
quoted forward by every later session as established fact.

Origin: 2026-07-24 — the xlsx suppressions expired and correctly blocked a
push. Re-verification confirmed `package.json` still installs xlsx from the
patched SheetJS CDN tarball, so the suppression was renewed with fresh
evidence, not rubber-stamped.

## Step 4: If a fix requires a version override

**Never blanket-override a package that has incompatible major lines**
(rule 53). Check whether the package's major versions changed their public
shape (CJS export style, function vs. named-exports, callback vs. promise)
before forcing a jump. Use:

- npm: version-scoped overrides (`"overrides": { "pkg": "1.x" }` pins to a
  compatible line rather than forcing every consumer to the newest major).
- pnpm: path-scoped overrides
  (`"pkg-a>pkg-b>brace-expansion": "2.0.1"`) so only the vulnerable path is
  touched, not every consumer of the shared dependency.

Origin: 2026-07-25 — `brace-expansion` 1.x exports a bare function; 2.x+
use named exports. `@babel/core`/istanbul (jest's coverage provider) call
it as a function. A blanket override to 2.x cleared the CVE but broke
`jest --coverage` outright across the whole suite.

## Step 5: Verify the fix with `npm ci`, never `npm install` (rule 52)

```bash
cd app && rm -rf node_modules && npm ci && npm test
```

`npm install` can resolve a dependency tree incrementally around what's
already on disk and silently paper over a break that only shows up on a
clean install — which is exactly what CI does.

Origin: 2026-07-25 — the `brace-expansion` override above was "verified"
locally with `npm install`, passed, then failed CI with
`TypeError: minimatch is not a function` across the whole unit suite. `npm
ci` would have caught it in the same terminal, before the push.

## Step 6: Document in the PR

If this sweep is part of a PR (not a standalone dependency-only PR), the
PR body's scan/gate section names every new finding and its terminal
state. If it's a standalone sweep ahead of a merge train, its own PR body
says so explicitly so reviewers know why it's not fixing a feature.
