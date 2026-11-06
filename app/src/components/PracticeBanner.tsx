// /app/src/components/PracticeBanner.tsx
//
// Says on every screen that this is a practice copy (GAP-28), so nobody takes a
// practice sale for a real one or real work gets entered here by mistake. Rendered
// by both routers' outermost documents (app/layout.tsx, pages/_document.tsx), which
// are the only places every screen passes through. It prints too, so a practice
// receipt can't be mistaken for a real one. No hooks, so it renders in either.

export function PracticeBanner() {
  return (
    <div
      role="status"
      className="sticky top-0 z-[100] bg-amber-400 px-4 py-1 text-center text-sm font-semibold text-black"
    >
      Practice copy. Nothing here is real: no card is charged and no message is sent.
    </div>
  );
}
