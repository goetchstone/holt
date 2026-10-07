// /app/src/components/ui/CostHiddenNote.tsx
//
// The one line a screen shows where its cost figures would be, when the server
// left them out because the viewer does not hold "View cost" (SEC-14,
// lib/auth/costVisibility.ts). A screen never shows $0 for hidden cost.

export function CostHiddenNote({ className = "" }: { readonly className?: string }) {
  return (
    <p className={`text-xs text-brand-gray italic ${className}`}>
      Cost figures are hidden for your role.
    </p>
  );
}
