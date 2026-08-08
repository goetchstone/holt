# Implementation plan — five deployment constants → config presets

**Repo:** `/Users/goetch/holt` · **App:** `/Users/goetch/holt/app`
**Verification path:** integration tests cannot run locally; green CI is the gate. `main`'s ruleset serialises merges, so these land one PR at a time in the order below.
**Before every PR:** `npm ci` (never `npm install`) — CLAUDE.md:140-142 (rule 52).

---

## 0. What the refuters changed, and what that changed in this plan

Five corrections drove design decisions. Where a refuter contradicted an investigator, **the refuter is taken as correct** and the plan follows the refuter.

| # | Setting | Refuter correction | Consequence in this plan |
|---|---|---|---|
| R1 | Pay period | The investigator said an anchor change splits stored confirmation rows. **False.** `payPeriodFromStart` (`app/src/lib/payPeriod.ts:91-98`) derives `endExclusive` from the *supplied* `startMid` at `:93` and `end` at `:94`; the anchor appears only at `:95-96` to compute `index`, and `index` is **never persisted** (absent from the create data at `app/src/lib/payPeriodConfirmationService.ts:80-89` and `:137-147`). An **anchor** change needs no backfill; a **length/shape** change re-derives `end` from the same `start` and misses every stored row. | Pay-period cadence is **deferred out of this series** (§7). The dangerous half is the *shape*, not the anchor — and shape is the half that needs a strategy registry, a migration, and two client components. |
| R2 | Pay period | `PERIOD_DAYS` is **not** module-private. `/Users/goetch/holt/app/src/app/(dashboard)/app/reports/pay-period-sales/PayPeriodSalesView.tsx:24` declares its own `const PERIOD_DAYS = 14;`, used at `:256` and `:262` via `gotoPeriod` (`:126-130`) → `shiftYmd` (`:47-51`). Rule 37 is **already violated**, and this file mints every `periodStart` that reaches the ledger (`:137`, `:173`). Verified: I read those lines. | The dedup of that literal is a named prerequisite of the deferred pay-period work, listed in §7 so it is not discovered mid-PR. |
| R3 | Commission tiers | Trap 5 ("a lost `ruleKey` restarts the designer at 3%") is wrong. `commissionRuleEngine.ts:582-589` recomputes `basisAtStart` live when `priorEntry` is absent — drift-sized, not a year reset. The **dangerous** direction is `:588` setting `priorRecognized = 0`, which for a RETROACTIVE rule makes `applyTierMode` (`:510-512`) recompute `owedAtEnd - 0` and **overpay**. | The ruleKey-stability test stays (C4/C6) but is justified by the *overpay* mechanism, not the reset. The applier is built so `syncLegacyMirrorRule` (`app/src/lib/commissionPlans.ts:210`) is the only writer of that rule, preserving its id. |
| R4 | Commission tiers | `docs/tenant-literal-sweep.md:942` already prescribes the **opposite** of "keep `DEFAULT_COMMISSION_TIERS` as a last resort": *"Make the fallback refuse rather than guess."* The investigator never cited the file. | Named as an **owner decision** (§7, OD-1) and explicitly **not** adopted in PR 1, because adopting it breaks the equivalence promise (`previewPayoutsForPeriod` would error where it now returns numbers). |
| R5 | Bonus rate | `totals.bonus` is **never rendered** — `MonthlyPerformanceView.tsx:265` is an empty `<td/>`. And **zero** existing test coverage: `grep -rni "bonus" app/__tests__` returns nothing. There is no "before" to diff against. | PR 4 begins with a **golden capture on current HEAD**, committed before any source is touched (§6.4). Non-negotiable sequencing. |
| R6 | Split credit | `commissionPayout.ts:246` clamps `Math.max(0, round2(ytdAtEnd - ytdAtStart))`. Lower the share mid-year and the slice goes negative and is silently recorded as **zero sales**. Also: `presetSchema.ts:293` (`rank: z.number().int().min(0).max(100)`) **is** the scalar worked example the investigator said did not exist — verified. And `app/src/lib/appSettings.ts:169-170` already has the 60 s cache with `invalidateAppSettingsCache` exported at `:191`. | `splitCreditShare` is **not shipped as a preset field** in this series (§7, OD-2). PR 3 is a pure rule-37 collapse with zero behaviour change. |
| R7 | Till variance | There is **no UI for the unblock route** (`grep -rn "unblock" --include="*.tsx" app/src` → zero). The "recoverable" framing is too soft. Also the investigator's T9 round-trip test is a tautology, and nothing in its plan exercises the minor-unit conversion end to end. | The `cash-control` applier ships with an explicit no-off-switch note; C11 asserts the export **contains** the preset; U7 tests the YAML→resolve→classify chain at the exact boundaries. |

---

## 1. How many kinds — decision and justification

**Three new kinds, not one. One setting gets no kind at all. One setting is deferred entirely.**

| Setting | Answer | Why |
|---|---|---|
| Commission tiers | New kind **`commission-plan`**, seeding the **existing** `CommissionPlan` + `CommissionPlanTier` tables | The task's own rule: *if an existing DB table covers it, seed that table.* `CommissionPlan` (`app/prisma/schema.prisma:4194-4220`) and `CommissionPlanTier` (`:4222-4233`) exist with full CRUD (`app/src/lib/commissionPlans.ts:139` validate, `:253` replace, `:292` create) and a live resolution chain (`commissionPlans.ts:72`, `commissionRules.ts:220`). **Zero runtime call-site changes** — `loadLegacyOrDefaultTiers` (`commissionPlans.ts:72-85`) already prefers the DB. Target **`CommissionPlan`/`CommissionPlanTier`, never `CommissionTier`**: `schema.prisma:4176-4179` states that table *"stays as the restore landing target … no code writes it anymore"*, and a plan wins over it in both chains. A `kind` literal is still required because `applyPreset`'s dispatcher switches on it (`app/src/lib/config/applyPreset.ts:104-114`). |
| Till thresholds | New kind **`cash-control`** | Its own vocabulary, owned by `app/src/lib/tillVariance.ts` (rule 37, CLAUDE.md:61-62). Bundling it with payroll numbers would put a second owner on the cash-control vocabulary. |
| Bonus rate | New kind **`payroll-defaults`** | Distinct vocabulary from cash control; shares a target (AppSettings scalars) but not a meaning. |
| Split credit share | **No preset field in this series.** PR 3 is a rule-37 collapse only | The code cannot honour any value except 0.5. Six selects OR `salesPersonId` with `splitWithId` and never select `salesPersonId` (`commissionSales.ts:55-62`, `:105-131`; `payPeriodSales.ts:157-172`; `monthlyPerformance.ts:102-113`; `salespersonDetail.ts:146-165`; `designerDashboard.ts:449-455`), so a 0.6 share credits *both* partners 0.6 = 120 % of the order. `salesBySalespersonReport.ts:233` posts **one** halved line to both buckets. `commissionPayout.ts:246` clamps a negative slice to zero. Shipping a field that is wrong for every value but its default is worse than shipping nothing. |
| Pay-period cadence | **Deferred.** Kind `pay-period-cadence` not written | Needs an owner decision on which cadences ship, a compile-time strategy registry, a migration, threading into **two** `"use client"` components, and the `PERIOD_DAYS` dedup (R2). See §7, OD-3. |

**Why not one kind for all four scalars.** Three reasons, in order of weight:

1. **Ship granularity.** An apply is atomic per preset. One kind = one YAML = one PR; a bad till threshold would block the commission plan from landing. The task asks the riskiest thing to ship first and alone; one kind makes that impossible.
2. **Rule 37.** `tillVariance.ts` owns cash thresholds; `goalsConfig.ts` owns the bonus rate; `commissionTiers.ts` owns tier vocabulary. One kind naming all three makes `presetSchema.ts` a fourth owner of three vocabularies.
3. **The applier shapes differ.** `commission-plan` delegates to existing transactional helpers that also sync a rule row (`commissionPlans.ts:276`, `:331`). The other two write scalar columns. Nothing is shared but the diff-before-write discipline, which `reconcile()` (`applyPreset.ts:188`) already generalises.

**Why disjoint columns make multiple kinds safe.** `AppSettings` is a singleton per org (`schema.prisma:4785`, `organizationId Int @unique`) and therefore has no `(kind, name)` identity to reconcile against. Two *different* kinds cannot collide because each applier writes a compile-time-disjoint column set. Two presets of the *same* kind can, so each scalar applier carries a **single-instance ownership check** modelled exactly on `currentTrafficStoreOwners` (`applyPreset.ts:741-766`, which reads `ConfigChangeLog.summary` newest-first over `action: { in: ["APPLIED","UNCHANGED"] }`).

**The org problem, resolved.** `ApplyPresetOpts` (`applyPreset.ts:70-80`) carries `source`/`actor`/`dryRun`/`prisma` and no organization. Decision: scalar appliers target `DEFAULT_ORG_ID` (`app/src/lib/appSettings.ts:19`) and **fail loudly** if `appSettings.count() > 1`, naming the count. Do not invent an org selector in this series.

**No DDL defaults on any new column.** All new `AppSettings` columns are **nullable with no `@default`**; the shipped value lives once, in the module that owns the vocabulary, and is merged in `resolveAppSettings` (`appSettings.ts:121-167`) over `DEFAULT_APP_SETTINGS` (`:74-91`). This is the fix for the refuter's observation that a Postgres `DEFAULT` can never equal a runtime-resolved preset value — the existing `bonusRate Decimal @default(0.06)` (`schema.prisma:2964`) is exactly that bug, and PR 4 removes it.

---

## 2. The zod schema — code to add to `app/src/lib/config/presetSchema.ts`

### 2a. Prerequisite move (PR 1) — lift the tier validators so one file owns them

`validatePlanTiers` / `validateTierFields` / `validateTierBrackets` live at `app/src/lib/commissionPlans.ts:139-179`, in a file that imports prisma. `presetSchema.ts` is isomorphic (`:10-15`) and cannot import it. **Move all three verbatim into `app/src/lib/commissionTiers.ts`** — which has **zero imports of its own** (verified: the file's first statement is `export interface CommissionTier` at `:18`) and therefore qualifies under the documented exception at `presetSchema.ts:17-25`, the same argument that admits `permissionCatalog.ts`. Re-export from `commissionPlans.ts` so `pages/api/admin/reports/commission-tiers/tiers.ts` and existing tests keep compiling. Do **not** restate the bracket rules as a zod superRefine — that would be a second source of truth.

### 2b. New schemas

```ts
// --------------------------------------------------------------------------
// kind: commission-plan
// --------------------------------------------------------------------------
//
// Seeds an EXISTING pair of tables (CommissionPlan / CommissionPlanTier),
// which is why this kind carries no storage opinion of its own. The five-band
// ladder in commissionTiers.ts:35-41 is one employer's schedule; on a fresh
// deployment with no plan and an empty CommissionTier table it is what every
// designer is priced on (commissionPlans.ts:84). This file is how a deployment
// states its own.
//
// Rule 62 holds trivially: every field is a scalar. The marginal arithmetic
// (commissionTiers.ts:77-118) and the rule derivation
// (commissionRuleEngine.ts:800-824) stay in code.

import { validatePlanTiers } from "@/lib/commissionTiers"; // pure, no imports of its own

export const commissionPlanTierPresetSchema = z.object({
  /** CommissionPlanTier.label (schema.prisma:4226). Rendered in the UI and
   *  frozen into every payout snapshot, so a label that differs by one
   *  character makes historical and new rows read as different tiers. */
  label: z.string().min(1).max(100),
  minYtdSales: z.number().min(0),
  /** null = unbounded. Only the LAST tier may be unbounded; enforced by
   *  validatePlanTiers below, not restated here. */
  maxYtdSalesExclusive: z.number().positive().nullable().default(null),
  /** Fraction, not percent — the storage unit at schema.prisma:4229 and the
   *  bound validateTierFields already enforces (commissionTiers.ts, moved
   *  from commissionPlans.ts:151-153). */
  rate: z.number().min(0).max(1),
});

export const commissionPlanPresetSchema = z
  .object({
    kind: z.literal("commission-plan"),
    name: presetNameSchema,
    description: z.string().max(2000).optional(),
    /** CommissionPlan.name — @unique at schema.prisma:4196. This is the row
     *  this preset claims; see applyPreset's adoption rule. */
    planName: z.string().min(1).max(100),
    /** Array ORDER is sortOrder. There is deliberately no sortOrder field:
     *  validatePlanTiers checks contiguity in array order
     *  (commissionPlans.ts:175) while every read path re-sorts by sortOrder
     *  (commissionPlans.ts:106, :370; commissionRules.ts:214, :217), so an
     *  author-supplied sortOrder that disagrees with array order passes
     *  validation and then computes against a different bracket sequence.
     *  createPlan and replacePlanTiers already fall back to the index
     *  (`sortOrder: t.sortOrder ?? i`, commissionPlans.ts:273 and :320), and
     *  the admin UI forces `sortOrder: i` (CommissionTiersView.tsx:293-298).
     *  Omitting the field makes the file agree with both by construction and
     *  removes the @@unique([planId, sortOrder]) P2002 (schema.prisma:4232). */
    tiers: z.array(commissionPlanTierPresetSchema).min(1).max(50),
  })
  // Bracket contiguity, "only the last tier may be unbounded", rate range and
  // minYtdSales >= 0 are NOT restated here. commissionTiers.ts owns them
  // (rule 37) and the plans API already calls the same function.
  .superRefine((preset, ctx) => {
    const error = validatePlanTiers(
      preset.tiers.map((t, i) => ({ ...t, sortOrder: i })),
    );
    if (error) ctx.addIssue({ code: "custom", message: error, path: ["tiers"] });
  });

// --------------------------------------------------------------------------
// kind: cash-control
// --------------------------------------------------------------------------
//
// The three till-variance cut points (tillVariance.ts:38, :41, :44). The
// four-tier ladder, the strict-`>` comparison (tillVariance.ts:68/:71/:74)
// and the register block (tillVariance.ts:113-136) stay in code — the file
// supplies three numbers and selects nothing else.

export const cashControlPresetSchema = z
  .object({
    kind: z.literal("cash-control"),
    name: presetNameSchema,
    description: z.string().max(2000).optional(),
    /** MINOR units of AppSettings.currency (schema.prisma:4798) — cents for
     *  USD. Integers, so the strict-`>` boundary semantics survive: the
     *  classifier compares Math.round(|variance| * 100) against these, and
     *  variance is already 2dp (close.ts round2 at :17-19, and Decimal(10,2)
     *  on the reconcile path at reconcile.ts:65). A float threshold that
     *  landed on 4.999999999999999 would flip exactly-$5.00 from NONE to
     *  NOTE, which is the one boundary the existing tests pin
     *  (tillVariance.test.ts:38-42). */
    noteThresholdMinor: z.number().int().min(0).max(100_000_000),
    managerThresholdMinor: z.number().int().min(0).max(100_000_000),
    escalationThresholdMinor: z.number().int().min(0).max(100_000_000),
  })
  // All three REQUIRED, none defaulted. zod applies .default() before
  // .superRefine(), so a defaulted threshold is indistinguishable from an
  // authored one and the ascending check would either never fire or fire on
  // the shipped file itself. A policy file states the whole policy.
  .refine(
    (p) =>
      p.noteThresholdMinor <= p.managerThresholdMinor &&
      p.managerThresholdMinor <= p.escalationThresholdMinor,
    {
      message:
        "thresholds must ascend: noteThresholdMinor <= managerThresholdMinor <= escalationThresholdMinor. " +
        "Out of order, the escalation branch (tillVariance.ts:68) swallows every variance and a $6 " +
        "discrepancy blocks a register.",
      path: ["managerThresholdMinor"],
    },
  );

// --------------------------------------------------------------------------
// kind: payroll-defaults
// --------------------------------------------------------------------------
//
// Scalar payroll policy. One field today; splitCreditShare joins it when the
// primary/partner asymmetry in the query shape is fixed (see the plan's §7).
// Additive fields do not bump PRESET_SCHEMA_VERSION — this file's own rule
// at :38-42.

export const payrollDefaultsPresetSchema = z.object({
  kind: z.literal("payroll-defaults"),
  name: presetNameSchema,
  description: z.string().max(2000).optional(),
  /** BASIS POINTS, integer. 600 = 6% = the current DEFAULT_BONUS_RATE
   *  (goalsConfig.ts:31). Integer basis points rather than a 0..1 fraction
   *  for two reasons. (1) The admin modal can only round-trip one decimal
   *  place of percent: SalesGoalsView.tsx:294-296 sets step="0.1", :87 does
   *  Math.round(rate * 100) to build the string and :94 divides by 100 to
   *  read it back, so a stored 0.035 renders as "4" and a manager pressing
   *  Save writes 0.04 — a half-point overpay. multipleOf(10) bounds the
   *  preset to exactly what that modal survives. (2) 600 / 10_000 evaluates
   *  to the same double as the literal 0.06, so equivalence is exact. */
  defaultBonusRateBps: z.number().int().min(0).max(10_000).multipleOf(10),
});
```

### 2c. Union registration

```ts
export const presetSchema = z.discriminatedUnion("kind", [
  importDefinitionPresetSchema,
  trafficStoreMappingPresetSchema,
  rolesPresetSchema,
  commissionPlanPresetSchema,   // PR 1
  cashControlPresetSchema,      // PR 2
  payrollDefaultsPresetSchema,  // PR 4
]);

export type CommissionPlanPreset = z.infer<typeof commissionPlanPresetSchema>;
export type CashControlPreset = z.infer<typeof cashControlPresetSchema>;
export type PayrollDefaultsPreset = z.infer<typeof payrollDefaultsPresetSchema>;
```

Adding to the union at `presetSchema.ts:371-375` is what makes the compiler route you to the other required edits — see §4.0.

---

## 3. Shipped default YAML — Saybrook's current values verbatim

### `/Users/goetch/holt/config/presets/commission-plan.yaml` (PR 1)

Values reproduce `app/src/lib/commissionTiers.ts:36-40` exactly, **including the EN DASH (U+2013)** in three labels. A label differing by a dash character makes historical payout rows and new rows render as different tiers.

```yaml
# Designer commission ladder — SHIPPED DEFAULT.
#
# The five bands that used to live only as DEFAULT_COMMISSION_TIERS in
# app/src/lib/commissionTiers.ts:35-41. That constant remains in source as the
# pre-database last resort (commissionPlans.ts:84 returns it when the
# CommissionTier table is empty); this file is what a deployment actually runs
# on, because a plan wins over the legacy table in both resolution chains
# (commissionPlans.ts:122, commissionRules.ts:271).
#
# A deployment overrides this by dropping a file with the SAME preset name
# ("commission-plan") into config/local/. Local wins.
#
# Marginal, not retroactive: crossing a threshold earns the new rate on the
# above-threshold portion only (commissionTiers.ts:6-11). That is code and
# this file cannot change it — only where the bands sit.

version: 1
description: Saybrook's 3–7% YTD-banded designer commission ladder.

presets:
  - kind: commission-plan
    name: commission-plan
    planName: Standard
    description: >-
      Five marginal YTD bands. Tier order in this list IS sortOrder — the
      brackets must be contiguous and only the last may be unbounded
      (validatePlanTiers, lib/commissionTiers.ts).

    tiers:
      - label: Up to $750k
        minYtdSales: 0
        maxYtdSalesExclusive: 750000
        rate: 0.03

      - label: $750k – $1M
        minYtdSales: 750000
        maxYtdSalesExclusive: 1000000
        rate: 0.04

      - label: $1M – $1.5M
        minYtdSales: 1000000
        maxYtdSalesExclusive: 1500000
        rate: 0.05

      - label: $1.5M – $2M
        minYtdSales: 1500000
        maxYtdSalesExclusive: 2000000
        rate: 0.06

      # Unbounded ceiling — maxYtdSalesExclusive omitted (defaults to null).
      # Only the last tier may do this.
      - label: Over $2M
        minYtdSales: 2000000
        rate: 0.07
```

`planName: Standard` is deliberate: migration `20260611_commission_plans/migration.sql:47-50` creates a plan named `'Standard'` when `CommissionTier` has rows **and** no `CommissionPlan` exists. The applier's adoption rule (§4.1) makes that a zero-write `UNCHANGED` when the tiers already match, and a loud `FAILED` when they do not.

### `/Users/goetch/holt/config/presets/cash-control.yaml` (PR 2)

```yaml
# Cash-drawer variance policy — SHIPPED DEFAULT.
#
# The three cut points that used to be TILL_VARIANCE_NOTE_THRESHOLD /
# _MANAGER_ / _ESCALATION_THRESHOLD at app/src/lib/tillVariance.ts:38, :41
# and :44. Values below reproduce $5 / $20 / $100 exactly.
#
# Stored in the MINOR units of AppSettings.currency (cents for USD) so the
# currency setting selects something. The classifier compares
# Math.round(|variance| * 100) against these with strict `>` — a variance of
# exactly $5.00, $20.00 or $100.00 does NOT trip the next tier
# (tillVariance.ts:59-64).
#
# What each tier does, so an operator setting these knows the stakes:
#   note       — the till CLOSE is refused without a note (close.ts:83-86,
#                re-checked at reconcile.ts:73-80).
#   manager    — labels the tier and populates `varianceClassification` in the
#                response (close.ts:149, reconcile.ts:111). It enforces
#                NOTHING today: reconcile.ts:119 already requires MANAGER or
#                ADMIN for every reconcile regardless of size, which its own
#                header calls a superset of this rule. Setting it changes the
#                label, not the gate.
#   escalation — Register.blockedAt is written (tillVariance.ts:126-135) and
#                new till opens on that register return 409
#                (registers/[id]/tills/open.ts:58-67). There is NO admin UI
#                for the unblock route — clearing it means an authenticated
#                POST to /api/registers/[id]/unblock with a resolutionNote.
#                Set this one conservatively.
#
# A deployment overrides by dropping the SAME preset name into config/local/.

version: 1
description: Saybrook's $5 / $20 / $100 till-variance thresholds.

presets:
  - kind: cash-control
    name: cash-control
    noteThresholdMinor: 500
    managerThresholdMinor: 2000
    escalationThresholdMinor: 10000
```

### `/Users/goetch/holt/config/presets/payroll-defaults.yaml` (PR 4)

```yaml
# Payroll scalar defaults — SHIPPED DEFAULT.
#
# defaultBonusRateBps replaces DEFAULT_BONUS_RATE (app/src/lib/goalsConfig.ts:31)
# and the two sibling literals that encoded the same 6%: the "6" string at
# SalesGoalsView.tsx:87 and the Postgres column default at
# schema.prisma:2964 (removed by the migration in this PR).
#
# 600 bps = 6%. Basis points, integer, in steps of 10: the goals admin modal
# is step="0.1" on a percent input (SalesGoalsView.tsx:294-296) and round-trips
# through Math.round(rate * 100) at :87, so any finer value silently changes
# the first time a manager opens and saves that goal.
#
# WHERE IT LANDS — two different roles, one number:
#   1. PERSISTED: goals.ts:49 writes it onto a SalesGoal row at creation when
#      the caller supplies no rate. Rows already created are NEVER rewritten
#      by an apply.
#   2. QUERY-TIME: monthlyPerformance.ts:80 seeds `bonusRate` for a
#      salesperson with NO SalesGoal row. For that person yearlyGoal is 0, so
#      goal is 0 (:144), variance is the whole of totalSales (:145) and the
#      bonus column is this rate applied to GROSS SALES, not to overage
#      (:147) — despite what schema.prisma:2964 and goalsConfig.ts:30 both
#      say. Changing this value moves those historical figures on the next
#      page load. That is preserved behaviour, not fixed behaviour.

version: 1
description: Saybrook's 6% over-goal bonus rate.

presets:
  - kind: payroll-defaults
    name: payroll-defaults
    defaultBonusRateBps: 600
```

---

## 4. Per-setting call-site changes, in dependency order

### 4.0 — What adding any kind touches (`docs/domains/config-presets.md:311-320`, plus two the doc omits)

| File | Compiler forces you? | Note |
|---|---|---|
| `app/src/lib/config/presetSchema.ts:371` | n/a | Union member. |
| `app/src/lib/config/applyPreset.ts:104-114` | **Yes** | `let outcome: KindOutcome;` is declared at `:102` and read at `:125`; the switch has no `default`. `tsconfig.json:18` sets `strictNullChecks: true` (`:12` sets `strict: false`), which is what makes definite-assignment analysis fire. |
| `app/src/lib/config/presetSerialize.ts` `orderBundle` | **Yes** | The unguarded fall-through return reads `preset.targetEntity`; a new union member stops narrowing to `ImportDefinitionPreset`. |
| `app/src/lib/config/dbConfigState.ts` | **No — silent** | It builds a `PresetBundle` by construction (`:100-190`) and today emits only `import-definition` and `traffic-store-mapping`; `roles` is already absent. Omitting a new kind compiles and makes the GUI export lossy. |
| `.../admin/settings/configuration/ConfigurationView.tsx:27-31`, `:134-154` | **No — silent** | One panel per kind, imported and rendered by hand. Verified: five panels, none for `roles`. |
| `app/__tests__/config/presets.test.ts` | **No** | Header at `:1-10`: *"Pure — no database."* Extend the YAML/JSON parity block. |
| `config/presets/README.md` "Kinds" | **No** | Already stale for `roles`. |

`ConfigChangeLog.presetKind` is a plain `String` (`schema.prisma:5537`), not a Prisma enum — a new kind needs **no migration for the audit log**. `presetFiles.ts` discovers files by `fs.readdir` over `SHIPPED_PRESET_DIR` / `LOCAL_PRESET_DIR` (`:30-31`) and accepts `.yaml`/`.yml`/`.json` — dropping a file in requires no registration.

---

### 4.1 — PR 1: `commission-plan` (no migration, no runtime call-site change)

**Precondition, before writing a line of code.** Run against the Saybrook production database and record the answer in the PR description:

```sql
SELECT (SELECT count(*) FROM "CommissionTier")     AS legacy_tiers,
       (SELECT count(*) FROM "CommissionPlan")     AS plans,
       (SELECT count(*) FROM "CommissionPlanTier") AS plan_tiers,
       (SELECT count(*) FROM "CommissionPayout" WHERE "lockedAt" IS NOT NULL) AS locked_payouts;
SELECT p.id, p.name, p."isDefault", p."isActive",
       t."sortOrder", t.label, t."minYtdSales", t."maxYtdSalesExclusive", t.rate
  FROM "CommissionPlan" p LEFT JOIN "CommissionPlanTier" t ON t."planId" = p.id
 ORDER BY p.id, t."sortOrder";
```

Nothing in the repo seeds `CommissionTier` (`app/prisma/seed/demo/commissionPlan.ts` is demo-only with scaled-down numbers), and `config/local/saybrook.yaml` carries only a `traffic-store-mapping` and an `import-definition`. Which of the three fallback branches Saybrook is on today is **not determinable from the repo** — it must be read off production. If their plan tiers differ from `commissionTiers.ts:36-40`, the shipped YAML is wrong for them and they need a `config/local/` override; the applier will refuse rather than overwrite (below), which is the intended way to find out.

**Steps, in order.**

1. **Move the validators** (§2a): `validatePlanTiers`, `validateTierFields`, `validateTierBrackets` from `commissionPlans.ts:139-179` → `commissionTiers.ts`; re-export from `commissionPlans.ts`. No logic change. Update `app/__tests__/` imports.
2. **Add the schema** (§2b) and register in the union.
3. **Add `applyCommissionPlan(db, preset, opts)`** to `applyPreset.ts`, branch in the switch at `:104-114`. Its contract:
   - **Ownership** (mirrors `currentTrafficStoreOwners`, `applyPreset.ts:741-766): read `ConfigChangeLog` newest-first for `presetKind: "commission-plan"`, `action: { in: ["APPLIED","UNCHANGED"] }`, extracting `summary.ownedPlanName`. If another preset name owns `planName` → `failOutcome` naming it.
   - **Adoption of an unowned existing plan.** If a `CommissionPlan` named `planName` exists with no ownership history: adopt it **only if** its tiers already equal the preset's tiers, projected to `{label, minYtdSales, maxYtdSalesExclusive, rate}` in `sortOrder` order with `Number()` coercion (`dbTierToHelper`, `commissionPlans.ts:55-64` — Decimal columns at `schema.prisma:4227-4229` must be compared as normalised numbers, never as Decimal objects, or every apply reports a change). Equal → `UNCHANGED`, zero writes, record ownership in the summary. Not equal → `FAILED`, listing the differing tiers. Rationale: the migration-created `'Standard'` plan and a manager-edited plan look identical from here; taking over silently is how a preset overwrites an audited edit.
   - **Diff before writing** (rule 63, `applyPreset.ts:9-15`). No difference → `UNCHANGED`, `changes = {created:0,updated:0,deleted:0}`, no transaction. This is what stops `replacePlanTiers`'s unconditional `deleteMany` + recreate (`commissionPlans.ts:263-275`) from churning row ids on every run.
   - **Delegate, never hand-roll.** Plan absent → `createPlan({ name: planName, description, tiers })` (`commissionPlans.ts:292`). Plan owned and tiers differ → `replacePlanTiers(planId, tiers, actor)` (`:253`). **Both call `syncLegacyMirrorRule` (`:276`, `:331`)**, which finds-or-creates the mirror rule by `LEGACY_MIRROR_RULE_LABEL` (`commissionRuleEngine.ts:790`) so the rule's id — and therefore its `ruleKey` = `id:<n>` (`commissionRules.ts:120`) — survives. Do **not** copy the pattern at `app/prisma/seed/demo/commissionPlan.ts:58-82`, which upserts `commissionPlanTier` directly and never syncs the rule; that is a live in-repo instance of the bug.
   - **No `isDefault`, no `isActive` in the preset.** `createPlan` already sets `isDefault: existing === 0` (`commissionPlans.ts:315`), so the first plan on a fresh deployment becomes the default by the same rule the UI uses. Never call `setDefaultPlan` (`:337`) from an applier — it clears `isDefault` on every plan (`:341`), and two presets both claiming default would flip it back and forth on every apply. A deployment that already has plans sets the default in the admin screen.
   - **Report, do not block, on locked history.** Count `CommissionPayout` rows with `lockedAt != null` and `commissionPlanId = <plan>` in the current fiscal year and put it in `messages`. Do **not** fail: locked rows keep their own `tierDefinitionSnapshot` (`schema.prisma:4382-4384` — *"historical payouts continue to render their original math"*) and are skipped on re-commit (`runCommissionPayouts.ts:398-401`), so a tier edit cannot rewrite a paid commission. Blocking here would also make the preset weaker than the admin UI it mirrors — `replacePlanTiers` has no lock check.
4. **`orderBundle` branch** in `presetSerialize.ts` — emit `kind, name, description?, planName, tiers[{label, minYtdSales, maxYtdSalesExclusive, rate}]` in that fixed order; tiers in array order (do **not** sort — order is meaning here, unlike stores and roles).
5. **`dbConfigState.ts`** — render live plans back out as `commission-plan` presets, one per plan, named from ownership history (fall back to the plan's slugified name).
6. **`CommissionPlanPanel`** in `.../configuration/`, registered in `ConfigurationView.tsx:27-31` and `:134-154`.
7. **`config/presets/commission-plan.yaml`** (§3).
8. **Re-document `DEFAULT_COMMISSION_TIERS`** at `commissionTiers.ts:29-34`: it is the pre-database last resort at `commissionPlans.ts:84` and the fixture at `app/__tests__/commissionRuleEngine.test.ts:191`. `resolveTier` does `tiers.at(-1) as CommissionTier` (`commissionTiers.ts:139`) and returns `undefined` on an empty array, so it cannot simply be deleted. **Do not delete it in this PR** — see OD-1.

**Runtime call sites changed: none.** `loadLegacyOrDefaultTiers` (`commissionPlans.ts:72-85`), `resolvePlanTiersForStaff` (`:93`), `resolvePlanRulesForStaff` (`commissionRules.ts:199`), `previewPayoutsForPeriod` (`runCommissionPayouts.ts:206`) and `pages/api/admin/reports/commission-tiers.ts:93-96` are all untouched. That is the whole point of seeding an existing table.

---

### 4.2 — PR 2: `cash-control` (migration; establishes the AppSettings-scalar pattern)

**Dependency order within the PR:**

1. **`app/src/lib/tillVariance.ts` — add the policy type and the shipped default, keep the classifier pure and synchronous.**

```ts
export interface CashControlPolicy {
  noteThresholdMinor: number;
  managerThresholdMinor: number;
  escalationThresholdMinor: number;
}

/** Shipped default. The values that were TILL_VARIANCE_NOTE/MANAGER/
 *  ESCALATION_THRESHOLD at :38/:41/:44 — $5 / $20 / $100, in cents. This is
 *  the ONLY place these numbers appear in source; AppSettings' new columns are
 *  nullable with no DDL default and resolve through here. */
export const DEFAULT_CASH_CONTROL_POLICY: CashControlPolicy = {
  noteThresholdMinor: 500,
  managerThresholdMinor: 2000,
  escalationThresholdMinor: 10000,
};

export function classifyTillVariance(
  variance: number,
  policy: CashControlPolicy = DEFAULT_CASH_CONTROL_POLICY,
): TillVarianceClassification {
  // Compare in MINOR units on both sides. variance is already 2dp — close.ts
  // round2s it at :17-19 before :73, and the reconcile path reads a
  // Decimal(10,2) column (reconcile.ts:65) — so this is an exact integer and
  // the strict-`>` semantics at :68/:71/:74 are preserved bit for bit. Doing
  // the conversion the other way (minor / 100 into a float compare) is what
  // flips exactly-$5.00 from NONE to NOTE.
  const magnitudeMinor = Math.round(Math.abs(variance) * 100);
  if (magnitudeMinor > policy.escalationThresholdMinor) { /* ESCALATION */ }
  if (magnitudeMinor > policy.managerThresholdMinor)    { /* MANAGER */ }
  if (magnitudeMinor > policy.noteThresholdMinor)       { /* NOTE */ }
  /* NONE */
}
```

   The **default parameter** is what keeps `app/prisma/seed/demo/salesOrders.ts:505` and every assertion in `app/__tests__/tillVariance.test.ts` compiling unchanged. It mirrors `commissionTiers.ts:80` and `:128`.

   `varianceNoteRequiredMessage` (`:92`) and `applyRegisterVarianceBlock` (`:113`) take the same optional policy; both interpolate a threshold into operator-facing text (`:95`, `:131`), and `:131` writes it into the **persisted** `Register.blockReason`. Convert minor → display dollars once, at the interpolation point: `(policy.noteThresholdMinor / 100).toFixed(2)`.

2. **Migration** — three nullable `Int` columns on `AppSettings` (`schema.prisma:4783-4828`), placed next to `sourceAdapterId` with a comment in that column's style (`:4818-4822`):

```prisma
  /// Till-variance cut points, in the MINOR units of `currency` above.
  /// Replaces TILL_VARIANCE_NOTE/MANAGER/ESCALATION_THRESHOLD, which used to
  /// be literals in lib/tillVariance.ts (CLAUDE.md rule 61). Nullable with NO
  /// database default on purpose: a static DDL default can never equal a
  /// runtime-resolved preset value, so the shipped answer lives once, in
  /// tillVariance.ts's DEFAULT_CASH_CONTROL_POLICY, and is merged in
  /// resolveAppSettings(). A deployment that never runs apply-preset gets
  /// exactly today's $5/$20/$100.
  tillVarianceNoteMinor       Int?
  tillVarianceManagerMinor    Int?
  tillVarianceEscalationMinor Int?
```

3. **`app/src/lib/appSettings.ts`** — add `cashControl: CashControlPolicy` to `ResolvedAppSettings` (`:54-72`), to `DEFAULT_APP_SETTINGS` (`:74-91`, spreading `DEFAULT_CASH_CONTROL_POLICY`), to `AppSettingsRow` (`:94-113`, all three optional-nullable so a partial select degrades to the default the way `sourceAdapterId` does at `:112`), and to the merge in `resolveAppSettings` (`:146-166`). `resolveAppSettings` is pure and already unit-tested — keep it that way. Do **not** add it to `getPublicBranding` (`:199`).

4. **Route handlers.** `app/src/pages/api/tills/[id]/close.ts` — `const { cashControl } = await getAppSettings();` before the classify at `:81`, which is before the transaction opens at `:88`. Pass it to `classifyTillVariance` (`:81`), `varianceNoteRequiredMessage` (`:83-86`) and `applyRegisterVarianceBlock` (`:131-136`). Same in `reconcile.ts`: resolve before `:66`, thread to `:66`, `:73-80`, `:95-100`.

5. **Seed.** `app/prisma/seed/demo/salesOrders.ts:505` and `:539-546` — pass the resolved policy (or rely on the default parameter; either way, assert the demo still yields one NOTE, one MANAGER, one ESCALATION till and a blocked register, per `docs/domains/seed-data.md:159-169`).

6. **`applyCashControl`** in `applyPreset.ts`: single-instance ownership check (`summary.ownedSetting: "cash-control"` + preset name, newest-first over `ConfigChangeLog`); refuse if `appSettings.count() > 1`; read the current row for `DEFAULT_ORG_ID`; compare all three integers; equal → `UNCHANGED` with zero writes; else `upsert` inside `db.$transaction(..., TX_TIMEOUT.SHORT)` and then **`invalidateAppSettingsCache(DEFAULT_ORG_ID)`** — the resolver caches for 60 s (`appSettings.ts:169-170`, invalidator exported at `:191`), exactly as `applyTrafficStoreMapping` calls `invalidateTrafficStoreMap()` after its write.

7. `orderBundle` branch, `dbConfigState` emission, `CashControlPanel`, `config/presets/cash-control.yaml`, README "Kinds" entry.

8. **Stale prose to fix in the same PR** (each currently asserts one employer's numbers as product truth): `schema.prisma:3127` ("Set when a till closes with |variance| > $100"), `docs/domains/pos.md:47-49`, `tillVariance.ts:15` and the field doc comments at `:51/:53/:55`.

**Do not add** an "off" value (a nullable = disabled tier) in this PR. `> 0` meaning "every penny needs a note" is a real limitation, but a disabled tier is a fourth behaviour the enforcement branches at `close.ts:83-86` and `reconcile.ts:73-80` do not have, and it is not needed for equivalence.

**Do not** wire `AppSettings.currency` into the `$` in `tillVariance.ts:94-97` / `:130-133` here. It is real drift (a GBP deployment gets `$` in its 400 responses and its persisted `blockReason`) but it changes operator-visible strings and belongs with the `DENOMINATIONS` work at `docs/tenant-literal-sweep.md:1043`.

---

### 4.3 — PR 3: split-credit rule-37 collapse (no preset, no migration, no behaviour change)

This PR ships **no config**. It repays the rule-37 debt so that D1 (§7) becomes a two-file change instead of a nine-site one, and it does so where a regression is unambiguous because no number is supposed to move.

1. **Capture the goldens on current HEAD first** (see §6.3). Commit them before touching source.
2. **One owner.** Widen `creditMultiplier` at `app/src/lib/reports/designerDashboard.ts:152` (currently *not* exported — export it) or move it to a new `app/src/lib/salesCredit.ts`, signature `creditMultiplier(order: { splitWithId?: number | null; splitWith?: unknown }, share: number = SPLIT_CREDIT_SHARE_DEFAULT)`. `SPLIT_CREDIT_SHARE_DEFAULT = 0.5` lives there and nowhere else.
3. **Replace all nine literals**, threading `share` as a **parameter** from each report entry point — never a settings read inside a pure module. `app/src/lib/marginMath.ts` is in the **browser bundle** (`SalesBySalespersonView.tsx:32` and `SalesExplorerView.tsx:17` both import `formatMarginPct` from it and both are `"use client"`), so a prisma import there breaks the client build outright. `accumulateLineItem` (`designerDashboard.ts:167`) already demonstrates the parameter shape.
   Sites: `commissionSales.ts:67`, `:138`; `marginMath.ts:100-101` (`applySplit`); `designerDashboard.ts:153` and the **second, separate** literal at `:299` which keys off the `splitWith` *relation* (a `splitWithId` grep misses it) and gates the `HC_CONVERSION_THRESHOLD` comparison at `:301` — so it moves a converted-house-call **count**, not just a dollar figure; `monthlyPerformance.ts:132`; `salespersonDetail.ts:179`; `payPeriodSales.ts:178`; `salesBySalespersonReport.ts:233` and `:629`.
   Do not forget `app/src/pages/api/reports/sales-by-salesperson/export.ts`, which imports `marginMath` and appears in no investigator call-site list.
4. **Keep `applySplit`'s margin invariant.** It halves retail *and* cost so margin % is unchanged under split (`marginMath.ts:91-95`, enforced by `app/__tests__/marginMath.test.ts:96-120`). Both sides must scale by the same factor. Note that the existing test uses `toEqual`, not `toBe` — **do not** add a reference-identity assertion; it is not enforced today and would over-constrain the refactor.
5. **Fix the ten UI strings? No — inventory them.** The seven the investigator listed plus three the refuter found (`OrderDetailView.tsx:764` badge, distinct from the `:1227` dialog text; `SalespersonCorrectionsView.tsx:482`; `SalespersonDetailView.tsx:187`) plus the doc comment at `salespersonDetail.ts:4`. They are all still true at 0.5. Leave them and list them in the PR body as D1's checklist — changing copy in a no-behaviour-change PR muddies the diff.

---

### 4.4 — PR 4: `payroll-defaults` / bonus rate

**Sequencing is load-bearing.** `grep -rni "bonus" /Users/goetch/holt/app/__tests__` returns nothing. There is no "before" to diff against. **Write the golden (§6.4) against current HEAD, run it, commit the expected numbers, and only then touch source.** A golden authored after the refactor from expectations derived from the refactored code catches nothing.

1. **Migration:** `AppSettings.defaultBonusRateBps Int?` (nullable, no DDL default, same comment style as PR 2). **And remove `@default(0.06)` from `SalesGoal.bonusRate` (`schema.prisma:2964`)** — a static column default can never equal a runtime-resolved preset value, so leaving it means every deployment silently gets Saybrook's rate from Postgres no matter what its preset says.
2. **`goalsConfig.ts`** keeps `DEFAULT_BONUS_RATE = 0.06` at `:31` as the shipped last resort and the single owner of the number. It **cannot** read the database — its header at `:3-6` forbids server-only imports because `SalesGoalsView.tsx:16` (a client component) imports from it. Add `export const DEFAULT_BONUS_RATE_BPS = 600;` and `export function bpsToRate(bps: number): number { return bps / 10_000; }`. (`600 / 10_000` is the same double as the literal `0.06`; assert it.) This resolves the contradiction in the investigator's own report, which wanted both "keep at most a last-resort literal" and "assert no bare 0.06 survives in goalsConfig.ts" — the literal stays here, exactly once.
3. **`appSettings.ts`** — `defaultBonusRate: number` on `ResolvedAppSettings`, defaulting to `bpsToRate(DEFAULT_BONUS_RATE_BPS)`.
4. **Server call sites.** `app/src/pages/api/admin/sales/goals.ts:49` — `bonusRate: bonusRate ?? (await getAppSettings()).defaultBonusRate`, and drop the `DEFAULT_BONUS_RATE` import at `:10`. `app/src/lib/reports/monthlyPerformance.ts:80` — seed from the resolved value instead of the constant (import at `:14` goes). `getMonthlyPerformance` takes `prisma` as a parameter (`:64`); take the resolved rate as a parameter too, so the function stays stub-testable.
5. **Client.** `SalesGoalsView.tsx:87`'s `: "6"` literal must come from the server, not from a second hardcode. It is a `"use client"` file, so thread the resolved default in as a prop from the page. This is the site that actually determines what a manager sees — `:110` always sends `bonusRate`, so `goals.ts:49`'s `??` never fires from the app. **A change that fixes only `goals.ts` is a no-op from the UI.**
6. `applyPayrollDefaults` in `applyPreset.ts` — identical shape to `applyCashControl` (single-instance check, org check, diff, upsert, `invalidateAppSettingsCache`). **It must not touch `SalesGoal` rows.** See §5.
7. `orderBundle`, `dbConfigState`, `PayrollDefaultsPanel`, `config/presets/payroll-defaults.yaml`.
8. **Fix the wrong schema comment** at `schema.prisma:2955` — *"When monthlyWeights is null, a standard seasonal pattern is used"* is false; `resolveMonthlyWeights` (`goalsConfig.ts:43-52`) falls back to `evenMonthlyWeights()`, a flat 1/12 (`:34-36`). Implementing to the comment would move every monthly goal number.

**Also in the PR body, not the code:** `monthlyPerformance.ts` uses `prisma.salesGoal`. There is a **second, near-identically-named model** `SalesGoals` (plural) at `schema.prisma:1267-1276` — a separate goals system with no bonus field, written by `app/src/pages/api/goals/index.ts` and read by `app/src/pages/api/dashboard/weekly.ts:261`. They differ by one character and hit different tables. Anyone writing the migration or an integration fixture must not confuse them.

---

## 5. Persistence and backfill — the table that must not be got wrong

| Setting | Persisted? | Exactly where | Backfill decision | Reason |
|---|---|---|---|---|
| **Commission tiers** | **Yes** | `CommissionPayout.commissionAmount` (`schema.prisma:4380`), `.tierBreakdown` (`:4377`), `.tierDefinitionSnapshot` (`:4385`), `.commissionPlanId`/`.commissionPlanName` (`:4396-4398`), `.ruleEngineVersion` (`:4391`) — all written at `runCommissionPayouts.ts:410-415` | **LEAVE ALONE. No backfill, ever.** | `tierDefinitionSnapshot` exists precisely so *"if the tiers are later edited (e.g. raising the top rate), historical payouts continue to render their original math"* (`schema.prisma:4382-4384`). `commitPayoutsForPeriod` already skips rows with `lockedAt` set (`runCommissionPayouts.ts:398-401`). Unlocked DRAFT rows are updated in place on re-commit (`:422-429`) — that is the normal path, not a backfill. The only way to change a locked amount is `editPayout` (`:512`), which demands an audit reason (`:517-519`) and writes a `CommissionPayoutEdit` row (`:573-582`). **Operational rule: apply and verify the preset BEFORE the first lock of a period.** After that, correction is manual, per row, per designer. |
| **Till thresholds** | **Classification: no. Block: yes** | The four-field classification is computed at `close.ts:81` / `reconcile.ts:66` and only echoed in the response (`close.ts:149`, `reconcile.ts:111`) — no `Till` column holds a tier, so every historical till reclassifies correctly on the next read. But `Register.blockedAt` / `blockReason` (`schema.prisma:3131-3132`) are written by `applyRegisterVarianceBlock` (`tillVariance.ts:126-135`) | **LEAVE ALONE. No backfill.** | A block is a record of a past decision, not a cached computation. Raising the threshold does not un-block; lowering it does not retroactively block. Clearing requires `POST /api/registers/[id]/unblock` (`:67-75`) with `pos.till.adjust` and a `resolutionNote` — **and there is no UI for it** (`grep -rn "unblock" --include="*.tsx" app/src` returns zero), so an automated backfill would be the only mechanism that touched it, which is strictly worse than leaving it. `blockReason` interpolates the old threshold into stored prose (`tillVariance.ts:131`) and `unblock.ts:72` **appends** rather than replaces, so the stale number persists forever. That is audit text; leave it. |
| **Split share** | **Yes** — same `CommissionPayout` columns, via `sumDesignerSales` / `loadDesignerSaleRows` at `runCommissionPayouts.ts:100-101` and `:166`. **Not** persisted for pay-period statements: `PayPeriodConfirmation` (`schema.prisma:4461-4486`) stores no amounts, so a confirmed statement is recomputed on every read | **No backfill — and PR 3 makes none possible**, because no number moves | When D1 lands, the danger is mid-year: `ytdAtStart` comes from a prior locked row's frozen `ytdSalesAtEnd` (`runCommissionPayouts.ts:88-100`) while `ytdAtEnd` is recomputed live. Raise the share and the period slice absorbs the whole retroactive difference in one paycheque. **Lower it and the slice goes negative and is clamped to zero at `commissionPayout.ts:246` (`Math.max(0, round2(...))`, same clamp at `:110`)** — the designer gets a period recorded as zero sales, silently, with no error. D1 must therefore be applied only at a fiscal-year boundary, or be effective-dated. |
| **Bonus rate** | **Yes** — `SalesGoal.bonusRate` written at `goals.ts:49`'s create branch, and today also by the column default at `schema.prisma:2964`. The bonus **dollar figure** is never stored (recomputed at `monthlyPerformance.ts:147`, summed at `:174`) | **LEAVE ALONE. The applier must not write `SalesGoal`.** Report the count of rows whose rate differs from the new default, in `messages` | Three reasons. (1) The row carries no provenance — `SalesGoal` has `createdBy`/`updatedBy` but nothing recording that the value came from the default, so a backfill cannot tell a manager's deliberate 6 % from a defaulted one. (2) Rewriting a closed fiscal year's rate retroactively changes a bonus figure already paid. (3) **Ownership, not idempotency** — CLAUDE.md:105-107 says *"a preset is desired state, so a mapping deleted from the file is deleted from the database,"* so a preset that rewrote `SalesGoal` **would** be idempotent; it would just deterministically clobber the manager's audited edit (`goals.ts:41`, `updatedBy` stamped at `:43`) on every apply. Cite ownership, not rule 63, or someone will argue the rule the other way. **Say out loud:** leaving history alone does **not** protect the people it appears to protect. A salesperson with **no** `SalesGoal` row has `yearlyGoal = 0`, so `goal = 0` (`monthlyPerformance.ts:144`), `variance = totalSales` (`:145`), and their bonus column is the rate applied to **gross sales, every month, every year queried** (`:147`). They have no row to protect and their historical figures move on the next page load. |
| **Pay-period cadence** | **Yes** — `PayPeriodConfirmation.periodStart/periodEnd` (`schema.prisma:4467-4468`, `@@unique` at `:4484`), `PayPeriodIssue` (`:4500-4501`), `CommissionPayout.periodStart/periodEnd` (`:4363-4364`, `@@unique` at `:4420`) | **REFUTER CORRECTION — and it is the most important fact about this setting.** An **anchor** change needs **no backfill, ever**. A **length/shape** change is a data-migration event and is not a config apply at all | `payPeriodFromStart` (`payPeriod.ts:91-98`) computes `endExclusive` from the *supplied* `startMid` at `:93` and `end` at `:94`. The anchor is touched only at `:95-96`, to compute `index` — and `index` is **never persisted** (absent from the create data at `payPeriodConfirmationService.ts:80-89` and `:137-147`) and appears in no where-clause. Every write and read path that carries an explicit `periodStart` (`payPeriodSales.ts:88-91`; `payPeriodConfirmationService.ts:262-267` feeding `confirm.ts:42` and `report-issue.ts:35`; the manager grid at `payPeriodSales.ts:243-250`, which throws if `periodStart` is absent) is therefore **anchor-independent**. Changing the anchor changes which windows the UI offers going forward and shifts a displayed `index`. Changing `PERIOD_DAYS` re-derives `end` from the same `start` at `:93-94` and misses every stored row. The investigator merged these and named the anchor as the dangerous one. |

---

## 6. Equivalence tests

Runners: `npm run test:unit` → `jest --selectProjects unit` (`app/package.json:18`; `:17` is the identical `test` script). `npm run test:integration` → `bash scripts/run-integration-tests.sh` (`:19`), which needs a migrated `fbc_test_db` — **CI only, cannot run locally.**

### 6.1 Commission tiers

**Unit (local).**

- **U1 — the preset says what the constant says.** Load via `loadAllPresets(root, { shippedOnly: true })`. **`shippedOnly` is mandatory**: `presetFiles.ts:154-164` warns in its own comment that without it the test *"passes in CI (where the directory is empty, being gitignored) and fails on every machine that actually has a tenant configured."* Assert `bundle.presets[0].tiers.map(t => ({label, minYtdSales, maxYtdSalesExclusive, rate}))` `toEqual` `DEFAULT_COMMISSION_TIERS` (`commissionTiers.ts:35-41`) element-for-element in order. `toEqual` compares the en-dash labels as strings.
- **U2 — marginal math is bit-identical.** For each pair, `calculateMarginalCommission(start, end, presetTiers)` must equal `calculateMarginalCommission(start, end, DEFAULT_COMMISSION_TIERS)` on **both** `.commission` (`toBe`) and `.breakdown` (`toEqual`). Pairs: the seven already pinned at `app/__tests__/commissionRuleEngine.test.ts:181-189` — `(0, 500_000)`, `(3_000_000, 3_500_000)`, `(800_000, 1_050_000)`, `(700_000, 1_600_000)`, `(0, 2_500_000)`, `(800_000, 750_000)`, `(500_000, 500_000)` — **plus** `(1_499_999, 1_500_001)` and `(1_999_999, 2_000_001)`.
- **U3 — `resolveTier` boundaries.** The existing file (`app/__tests__/commissionTiers.test.ts`, describe `:15-39`) asserts 0 (`:17`), 749_999 (`:21`), 750_000 (`:25`), 1_000_000 (`:29`), 10_000_000 (`:33`), −500 (`:37`). It contains **no assertion at 1_500_000 and none at 2_000_000** — the exact points where the 6 % and 7 % bands begin. Assert `.label` and `.rate` match between preset tiers and the constant at: 0, 749_999, 750_000, 999_999, 1_000_000, 1_499_999, **1_500_000**, 1_999_999, **2_000_000**, 10_000_000, −500.
- **U4 — the rule engine agrees.** Re-run the golden-path body at `commissionRuleEngine.test.ts:180-237` with `legacyTiers` (fixture at `:191`) replaced by the preset-derived tiers: `deriveRuleFromLegacyTiers` (`commissionRuleEngine.ts:800`) → `computeRuleEnginePayout` (`:716`) vs `calculateMarginalCommission`. Compare `commissionAmount` `toBe` `commission`, and the projected breakdown `{tierLabel, rate, salesInTier, commission}` `toEqual`.
- **U5 — schema.** `parsePresetBundle` (`presetSchema.ts:470`) accepts the shipped bundle; rejects non-contiguous brackets, a non-last unbounded tier, `rate > 1`, `minYtdSales < 0`, and `tiers: []` — each error message coming from `validatePlanTiers`, proving the single owner is wired.
- **U6 — serializer parity.** `serializePresetBundle` → YAML and JSON → `parsePresetText` → `parsePresetBundle` both yield the identical bundle object. Extend the existing parity block in `app/__tests__/config/presets.test.ts` (header `:1-10`: "Pure — no database"). Note the **tier array order must survive** — this is the one kind where order is meaning.

**CI only (real Postgres).**

- **C1 — idempotency (rule 63).** `applyPreset(preset, {source:"test"})` twice on a fresh DB. First `APPLIED`; second `UNCHANGED` with `changes === {created:0,updated:0,deleted:0}` (`applyPreset.ts:9-15`). Exactly one `ConfigChangeLog` row per non-dry-run apply (`applyPreset.ts:251-260`); `dryRun: true` writes nothing at all, including no log row (`applyPreset.ts`, the `if (opts.dryRun) return result;` guard before the create).
- **C2 — adoption is a no-op.** Seed a `CommissionPlan` named `Standard` with tiers identical to the preset and no ownership history. Apply → `UNCHANGED`; the plan's `id` and its mirror rule's `id` are unchanged.
- **C3 — adoption of a divergent plan refuses.** Same, but with one rate edited. Apply → `FAILED`, message names the differing tier, and `CommissionPlanTier` rows are byte-identical afterwards.
- **C4 — `ruleKey` stability.** `resolvePlanRulesForStaff` (`commissionRules.ts:199`) → `rules[0].ruleKey` identical across two applies **and** across an apply that changes a rate. `syncLegacyMirrorRule` finds-or-creates by `LEGACY_MIRROR_RULE_LABEL` (`commissionRuleEngine.ts:790`) so `id` — hence `ruleKey` = `id:<n>` (`commissionRules.ts:120`) — survives.
- **C5 — THE paycheque check.** `previewPayoutsForPeriod` (`runCommissionPayouts.ts:206`). *Run A (control):* no `CommissionPlan` rows, no `CommissionTier` rows, designer with `commissionPlanId` NULL, orders spanning three tier boundaries (YTD $700 k before the period, $1.6 M after). Record `commissionAmount` and `tierBreakdown.entries`. *Run B:* apply the preset, re-run over the identical period. `commissionAmount` `toBe` Run A's; `tierBreakdown.entries` `toEqual` Run A's **after projecting away `ruleKey`, `ruleLabel` AND `ruleId`** — `RuleBreakdownEntry` carries `ruleId` (`commissionRuleEngine.ts:117`), which is `null` on the derived path (`:805`, `id: opts?.ruleId ?? null`) and a number on the plan path (`commissionRules.ts:118`). The dollars must match; the rule identity legitimately differs. Omitting `ruleId` from the projection reds the test on a non-difference.
- **C6 — chain continuity, in the direction that overpays.** Seed a prior **locked** `CommissionPayout` whose `tierDefinitionSnapshot.ruleState` carries the mirror rule's `ruleKey`. After the apply, assert the next period's `priorState` still matches that `ruleKey` (`runCommissionPayouts.ts:141-176`). A lost `priorEntry` does **not** reset the year — `commissionRuleEngine.ts:582-589` recomputes `basisAtStart` live from the full row set — but `:588` sets `priorRecognized = 0`, so a RETROACTIVE rule then computes `owedAtEnd - 0` at `:510-512` and **pays the whole re-rated base again**.
- **C7 — export round-trip contains the kind.** `loadDbConfigState()` → assert the bundle **contains** a `commission-plan` preset whose tiers match the DB, then serialize → parse → apply → `UNCHANGED`. The "contains" half is essential: `applyBundle` iterates only `bundle.presets` (`applyPreset.ts:131-140`), so a `dbConfigState` that omits the kind makes a bare round-trip assertion pass **in exactly the failure state it exists to detect**.

**Not automatable.** Whether Saybrook is on the constant, the legacy table, or a plan today. Run the SQL in §4.1 against production and record the answer before merging.

### 6.2 Cash control

**Unit (local).**

- **U7 — the exhaustive sweep (the real proof).** For every integer `n` from **−1 000 000 to +1 000 000 cents** (±$10 000; 2 000 001 values), assert `classifyTillVariance(n / 100, resolvedDefaultPolicy)` deep-equals a **frozen literal copy of the pre-change implementation** pinned inside the test file so it cannot drift. Compare the whole object — `level`, `requiresNote`, `requiresManager`, `blocksRegister`.
- **U8 — the minor-unit chain, end to end.** This is the check the investigator's plan never had: U7 passes a policy in directly and never exercises the YAML→resolve path, so a conversion that landed on `4.999999999999999` would pass U7, the file pin, and the schema test while flipping exactly-$5.00 from NONE to NOTE. Load `config/presets/cash-control.yaml` through `loadAllPresets({shippedOnly:true})`, resolve it through the same function `close.ts` will call, and assert: `5.00 → "NONE"`, `5.01 → "NOTE"`, `20.00 → "NOTE"`, `20.01 → "MANAGER"`, `100.00 → "MANAGER"` with `blocksRegister === false`, `100.01 → "ESCALATION"` with `blocksRegister === true`, `−100.01 → "ESCALATION"`.
- **U9 — existing table, unchanged.** Re-run `app/__tests__/tillVariance.test.ts` against the new signature with the default parameter. Load-bearing rows (ranges as they actually are, not as the investigator cited them): 5.00 → NONE at `:38-42`, 5.01 → NOTE at `:43-51`, 20.00 → NOTE with `requiresManager` false at `:63-68`, 100.00 → MANAGER with `blocksRegister` **false** at `:89-94`.
- **U10 — the constants assertion moves.** Replace `tillVariance.test.ts:119-121` (which asserts the constants are 5/20/100) with an assertion on the **shipped preset file**: `noteThresholdMinor === 500`, `managerThresholdMinor === 2000`, `escalationThresholdMinor === 10000`. That assertion is about one deployment's policy, not about the product.
- **U11 — message text.** `varianceNoteRequiredMessage(12.5)` under the default policy must be **byte-identical** to today's string (asserted at `tillVariance.test.ts:141-147`). It interpolates a threshold at `:95`, so it becomes policy-dependent; the classification return does not carry it, and "prove the classifier and you've proved the rest" is false for exactly this reason.
- **U12 — persisted block prose.** `applyRegisterVarianceBlock` against a stub — it takes `Pick<Prisma.TransactionClient, "register">` (`tillVariance.ts:101`), so no DB. Assert `blockReason` still reads `…exceeding the $100.00 escalation threshold…` (`:131`) under the default policy.
- **U13 — schema.** Rejects descending thresholds, negatives, non-integers, a missing field; accepts the shipped default.
- **U14 — the no-preset answer.** `resolveAppSettings(null)` (`appSettings.ts:121-128`) yields `DEFAULT_CASH_CONTROL_POLICY`. This is the "fresh clone, apply-preset never run" case, and it is what makes the nullable-no-DDL-default design safe.
- **U15 — local wins, without a database.** `loadAllPresets` resolves local-over-shipped entirely in fs plus an in-memory `${kind}/${name}` Map, and `resolveConfigRoot` (`presetFiles.ts:55-56`) honours `HOLT_CONFIG_DIR`. Point it at a temp dir with a shipped and a local `cash-control.yaml` of the same preset name; assert the local values win and the override is reported in `report.overrides`. **This is a unit test, not a CI test** — pushing it to CI leaves the override contract untested on the machine where it is written.

**CI only.**

- **C8 — idempotency**, as C1.
- **C9 — single-instance refusal.** Apply a second, differently-named `cash-control` preset. `FAILED`, message names the incumbent, zero writes to `AppSettings`.
- **C10 — route level, with the policy seeded.** `app/__tests__/integration/tillVarianceEnforcement.integration.test.ts` in full, **with the preset applied in setup**. It hardcodes a $150 close and asserts `blockReason` contains `"$150.00"` (`:174-176`) and `"shortage"` (`:203`); once the threshold is DB-resolved, those assertions only mean something if the fixture DB carries the policy. Also covers `varianceClassification` shape (`:139-143`), the block surviving a re-check (`:224`), unblock nulling `blockedAt` while appending history (`:245-249`), and reconcile applying the block for a till that reached CLOSED without `close.ts` (`:316-325`).
- **C11 — the demo seed still demonstrates the tiers.** `app/prisma/seed/demo/salesOrders.ts` manufactures −12.50 / +47.20 / −162.40 tills (`:487`, `:492`, `:497`) via `classifyTillVariance` (`:505`) and `applyRegisterVarianceBlock` (`:539-546`). Assert one NOTE, one MANAGER, one ESCALATION and a blocked register, per `docs/domains/seed-data.md:159-169`.
- **C12 — export round-trip contains the kind**, as C7.

**Neither unit nor CI — a manual gate before merge.** Historical replay against a **restored Saybrook dump**: `SELECT id, variance FROM "Till" WHERE variance IS NOT NULL`, classify every row old vs new under the default policy, assert (a) identical `level` for every row and (b) an identical set of till ids with `blocksRegister === true`. `docs/tenant-literal-sweep.md:1045` prescribes exactly this. It cannot run in CI against a seeded database and prove anything about Saybrook.

### 6.3 Split credit (PR 3)

**Capture first, on HEAD.** Before touching source, write and run a stub-prisma golden for `getDesignerDashboard`, `getMonthlyPerformance`, `getSalespersonDetail` and `getPayPeriodSales` over a fixture containing **at least one split order** and one non-split order, and commit the expected outputs. Then refactor and re-run.

**Unit.** `creditMultiplier` (exported) returns `0.5` for `{splitWithId: 7}` and `1` for `{splitWithId: null}`, and the same for the relation form `{splitWith: {...}}` — the second literal at `designerDashboard.ts:299` keys off the relation object. `applySplit({retail:1000,cost:400}, 0.5)` `toEqual` `{retail:500,cost:200}` with margin % unchanged (keep `app/__tests__/marginMath.test.ts:96-120` and `:194-205` green; use `toEqual`, not `toBe`). `accumulateLineItem` at 0.5 (already exercised at `app/__tests__/designerDashboardCost.test.ts:43`).

**Note honestly:** those three unit assertions are **invariance** tests, not equivalence tests of a setting. Each passes 0.5 in literally and asserts arithmetic; all three stay green if one report is left on a hardcoded `1`. The goldens above are what actually catches a missed site.

**CI.** `previewPayoutsForPeriod` byte-identical before/after for one designer and one period on identical seeds, including a case with a prior **locked** payout so `commissionPayout.ts:246`'s `Math.max(0, …)` is on the path. Do **not** assert `ytdSalesAtStart === priorLock.ytdSalesAtEnd` — `runCommissionPayouts.ts:99` is a plain assignment and that assertion is true for any share, including a broken one; assert the **derived slice** is a specific non-zero value instead. Plus, on one seed: `sumDesignerSales` (A=1500, B=500 for a $1000 non-split and a $1000 split); `loadDesignerSaleRows` on **all three** fields — `revenue` (`commissionSales.ts:144`), `margin` (`:147`) and `units` (`:148`); `getDesignerDashboard` `All.revenue` **and** the house-call `convertedCount` gated by `designerDashboard.ts:301`; `payPeriodSales.ts:144-145` `periodTotal`/`ytdTotal` **and** `:178` `creditedNet` (two different code paths); `salesBySalespersonReport.ts:233` buckets **and** `:629` `lineToItem` drilldown (separately gated at `:628`, rounding independently at `:640-642`); `pages/api/admin/reports/commission-tiers.ts:108-109`, the live pre-lock preview an operator eyeballs before committing a payout.

### 6.4 Bonus rate (PR 4)

**Golden first, on HEAD — there is no existing coverage to lean on.** `getMonthlyPerformance` (`monthlyPerformance.ts:64`) takes `prisma` as a parameter and makes exactly three calls: `staffMember.findFirst` (`:73`), `salesGoal.findUnique` (`:84`), `salesOrder.findMany` (`:94`). Hand-roll a stub with those three and cast it. Two cases, comparing the **full `MonthRow[]` plus totals**, and asserting `bonus` for **every month**, not just the total — rounding is per month (`:147`) and the YTD figure is the sum of already-rounded values (`:174`), so a total-only comparison can mask up to 12 cents of drift.

- **Case 1, goal row present.** `findUnique → {yearlyGoal: 1_200_000, bonusRate: 0.06, monthlyWeights: null}`; one ORDER dated 2026-01-15 with `netPrice: 150_000`. Expect `months[0].goal === 100000`, `variance === 50000`, `bonus === 3000`.
- **Case 2, NO goal row — the only case that exercises the constant.** `findUnique → null`. `yearlyGoal` stays 0, so `goal === 0`, `variance === totalSales`, and `bonus === Math.round(150000 * 0.06) === 9000`. **6 % of gross, not of overage.** Record that in a comment so nobody "fixes" it while doing this work.
- Add a third order with `splitWithId` set to exercise the 0.5 multiplier at `:132`, and respect the report's scope: `REVENUE_STATUSES` (`:62`) and `buildLineItemWhere([], false)` (`:111`) exclude cancelled lines and delivery/freight.

**Unit.** `DEFAULT_BONUS_RATE_BPS / 10_000 === 0.06` (`toBe`, exact double). Shipped-file pin via `loadAllPresets({shippedOnly:true})` → `defaultBonusRateBps === 600`. Schema rejects `605` (`multipleOf(10)`), `-10`, `10_001`, and a non-integer. Local-wins via `HOLT_CONFIG_DIR` + temp dir, **as a unit test**. Source tripwire in the style of `app/__tests__/reports.cancelledLineFilter.test.ts:23-35`: `0.06` appears in `goalsConfig.ts` **exactly once** (the shipped default lives there), and **nowhere** in `goals.ts`, `monthlyPerformance.ts`, or `SalesGoalsView.tsx` — and the `"6"` default at `SalesGoalsView.tsx:87` is gone.

**CI.** `@default(0.06)` is **removed** from `SalesGoal.bonusRate` — assert a raw INSERT omitting `bonusRate` now fails rather than silently landing 0.06. (Asserting "a raw INSERT lands the preset value" is unsatisfiable: a Postgres column default is static DDL and can only ever equal a runtime preset value by coincidence — green for Saybrook, red for every deployment this work exists to serve.) `PUT /api/admin/sales/goals` with `bonusRate` **omitted**, under an **overriding local preset**, must create a row carrying the override. Run only that half as the discriminating test — the Saybrook half (omit, expect 0.06) is a tautology that stays green even if the preset is completely unwired. Idempotency (as C1). **History untouched:** create a `SalesGoal` at 0.06, apply a preset with a different default, assert the row's `bonusRate` is still 0.06 **and its `updated` timestamp did not change**.

---

## 7. Out of scope, and the owner decisions to ask

Each is stated as **one question** so it can be asked and answered in one reply.

**OD-1 — Should the commission fallback refuse rather than guess?**
`docs/tenant-literal-sweep.md:942` prescribes: *"Make the fallback refuse rather than guess: `loadLegacyOrDefaultTiers()` returns an unconfigured result that payout preview and commit surface as a hard 'no commission plan configured' error."* That is the direct opposite of keeping `DEFAULT_COMMISSION_TIERS` as a last resort, and the doc's own equivalence test (*"empty `CommissionTier` on a scratch DB and assert preview **errors** instead of returning numbers"*) contradicts this plan's C5 Run A. Adopting it is a behaviour change that breaks the equivalence promise, so PR 1 keeps the constant and re-documents it. **Question: after the `commission-plan` preset ships, should `loadLegacyOrDefaultTiers` (`commissionPlans.ts:72-85`) stop returning `DEFAULT_COMMISSION_TIERS` and instead make payout preview and commit fail with "no commission plan configured"?**

**OD-2 — Split-order credit: symmetric-only, or per-order percentages?**
Blocked on real code work, not on a preset. Before any `splitCreditShare` config can be honest, three things must change: `salesPersonId` must be added to six selects (`commissionSales.ts:55-62`, `:105-131`; `payPeriodSales.ts:157-172`; `monthlyPerformance.ts:102-113`; `salespersonDetail.ts:146-165`; `designerDashboard.ts:449-455`) so the multiplier can branch per queried staff member; `salesBySalespersonReport.ts:233` must emit two distinct lines instead of posting one `halfLine` to both buckets (`:245`/`:250` and `:261`); and the mid-year `Math.max(0, …)` clamp at `commissionPayout.ts:246` and `:110` must be handled. `docs/tenant-literal-sweep.md:1020` further proposes `SalesOrder.splitPercent Decimal?` so an uneven split is representable *per order at all*. **Question: is an uneven split a deployment-wide constant (one `AppSettings` percentage), or a per-order fact the operator sets when they set the split (a `SalesOrder.splitPercent` column)? The answer decides whether this is a preset field or a schema migration plus a UI change.**

**OD-3 — Pay-period cadence: which cadences ship?**
Not in this series. The anchor alone is harmless (see §5), so a preset carrying only an anchor would be theatre — it would still hardcode the bi-weekly shape. A real fix needs: a compile-time cadence registry (the `runnerKey` construction — a preset **names** a strategy, it never supplies one, per `presetSchema.ts:157-161` and the hard failure at `applyPreset.ts` for an unresolvable runner); a migration for the storage columns; `payPeriodForDate`'s `Math.floor` division (`payPeriod.ts:67`) replaced by a calendar walk for any variable-length shape, with negative indices still working (`app/__tests__/payPeriod.test.ts:39-45`); a per-strategy rule for `payPeriodFromStart`'s deliberate off-anchor escape hatch (`payPeriod.ts:88-98`, test at `:88-94`), since `start + 13 days` is a bi-weekly fact; the cadence reaching **two** `"use client"` components as resolved data (`PayoutsTab.tsx:26-30`, called synchronously inside a `useState` initializer at `:143-144` and a `useMemo` at `:148`; and `PayPeriodSalesView.tsx`, which is `"use client"` at `:1`) — so `payPeriod.ts` can never become async or import prisma; the **duplicate `PERIOD_DAYS = 14` at `PayPeriodSalesView.tsx:24`** (used at `:256`/`:262`) removed, or the prev/next arrows will keep stepping 14 days after the library becomes shape-driven and mint `periodStart` values no strategy would emit, which `payPeriodFromStart` will happily accept and write into the ledger; the "anchor is a Sunday" assertion at `app/__tests__/payPeriod.test.ts:104-108` moved from a test of the **product** to a test of the **shipped default preset**; and `app/__tests__/integration/payPeriodIssue.integration.test.ts:27`, which calls `payPeriodForDate` at **module load**, reworked. **Question: which cadences must the product support — bi-weekly only, or also weekly / semi-monthly / monthly? Semi-monthly is the one that forces the calendar-walk rewrite; if the answer is "bi-weekly with a configurable anchor and period length," this becomes a much smaller change.**

**Explicitly not in any PR here.** Currency formatting for the `$` hardcodes at `tillVariance.ts:94-97` and `:131-133` and the US-only `DENOMINATIONS` table (`docs/tenant-literal-sweep.md:1043`). Wiring `AppSettings.locale` into `formatPeriodLabel`'s `"en-US"` (`payPeriod.ts:109-117`). Wiring the `MANAGER` tier into an actual gate — `requiresManager` is produced at `tillVariance.ts:69/:72/:75/:77`, echoed at `close.ts:149` and `reconcile.ts:111`, and **read by no branch**; `reconcile.ts:119` already requires MANAGER/ADMIN for every reconcile, which its own header at `:26-32` calls a superset of the ">$20 requires manager" rule. Narrowing that would be a behaviour change and would break the equivalence promise. Note it in the preset's `description` so a deployment setting `managerThresholdMinor` knows it currently labels the tier and gates nothing. Building an unblock UI (there is none — `grep -rn "unblock" --include="*.tsx" app/src` returns zero hits), which is the real cost of a deployment setting `escalationThresholdMinor` too low.