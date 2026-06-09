# Holt — Design System

How the UI stays one product instead of two design eras. Read this before
building any back-office page. Reference implementation:
`src/app/(dashboard)/app/admin/email/EmailQueueView.tsx`.

## The shell (don't re-create it)

The back-office runs inside `AppShell` (`components/navigation/AppShell.tsx`):
left sidebar (`AppSidebar`) + slim top bar (`AppTopbar`) + a single content
container (`mx-auto max-w-screen-xl px-4 py-6`). **Pages must NOT set their own
container/max-width/padding** — the shell owns it. A page's root is a plain
`<div>`; it starts with a `PageHeader`.

## Primitives (use these — don't hand-roll)

| Need | Use | Import |
|---|---|---|
| Page title + actions | `PageHeader` | `@/components/ui/PageHeader` |
| Any button | `Button` (`primary` / `secondary` / `outline`, `sm`) | `@/components/ui/button` |
| Status pill | `Badge` (`neutral`/`success`/`warning`/`danger`/`info`) | `@/components/ui/badge` |
| Card container | `Card` + parts | `@/components/ui/card` |
| Modal | `Modal` | `@/components/ui/Modal` |
| Tabs | `Tabs` | `@/components/ui/tabs` |
| Form fields | `form/*` (`FormInput`, `FormDropdown`, …) | `@/components/form/*` |
| Data tables | `PaginatedTable` / `TableWithFilters` | `@/components/table/*` |

## Tokens

Brand colors are the `sh-*` tokens only (`sh-navy`, `sh-blue`, `sh-gold`,
`sh-linen`, `sh-gray`, `sh-black`, `sh-stripe`, `sh-brand-blue`, `sh-brand-gray`),
driven by `AppSettings.theme` via `themeToCssVars()` so a tenant re-skins without
code. **Never hardcode hex.** Fonts: serif = Minion Pro (`font-serif`), sans =
Myriad Pro — headings are serif.

## Page recipe

```tsx
export function ThingView() {
  return (
    <div>
      <PageHeader title="Things" subtitle="..." actions={<Button>New</Button>} />
      {/* content: Cards, a table, form/* fields */}
    </div>
  );
}
```

## The rule (enforced)

**No raw `<button>`, `<input>`, `<select>`, or status `<span>` where a primitive
exists.** Headings go through `PageHeader`, not ad-hoc `<h1>`. This is the single
discipline that keeps the app cohesive; it's the lint/review gate added in U2.
The audit (2026-06-04) found only ~56% primitive adoption and a self-inflicted
regression in newer pages — this rule is the fix.

## Migration status (U2 sweep)

Cohered to the system: `EmailQueueView` (reference). Remaining visible pages
(comments moderation, helpdesk, scheduling, sales/customers, reports hub) convert
opportunistically as touched, highest-traffic first. The 200+ page long tail is
not hand-migrated — it inherits the shell automatically and converts when worked.
