"use client";

// /app/src/components/help/HelpButton.tsx
//
// The "?" in the top bar (GAP-30, DECISIONS 54): opens a side panel with the help
// article for the screen you're on, read from /api/help/article. The HTML arrives
// sanitized by the server (lib/help/articles.ts), from Markdown kept in the repo.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import axios from "axios";
import { CircleHelp, X } from "lucide-react";
import { getErrorMessage } from "@/lib/toastError";
import { HELP_PROSE } from "@/components/help/helpProse";

type PanelState =
  | { kind: "loading" }
  | { kind: "article"; title: string; html: string; slug: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

export function HelpButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PanelState>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    let current = true;
    setState({ kind: "loading" });
    axios
      .get("/api/help/article", { params: { screen: pathname } })
      .then((res) => {
        if (current) setState({ kind: "article", ...res.data });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (axios.isAxiosError(err) && err.response?.status === 404) setState({ kind: "none" });
        else setState({ kind: "error", message: getErrorMessage(err, "Help couldn't load.") });
      });
    return () => {
      current = false;
    };
  }, [open, pathname]);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-label="Help for this screen"
        aria-expanded={open}
        className="rounded-md p-2 text-brand-gray hover:bg-brand-stripe"
      >
        <CircleHelp className="h-5 w-5" />
      </button>
      {open && (
        <aside
          role="dialog"
          aria-label="Help"
          className="fixed inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-l border-black/10 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-black/10 px-4 py-3">
            <h2 className="font-serif text-lg font-semibold text-brand-blue">
              {state.kind === "article" ? state.title : "Help"}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close help"
              className="rounded-md p-2 text-brand-gray hover:bg-brand-stripe"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
            {state.kind === "loading" && <p className="text-brand-gray">Loading...</p>}
            {state.kind === "error" && <p className="text-red-700">{state.message}</p>}
            {state.kind === "none" && (
              <p className="text-brand-gray">This screen has no help article yet.</p>
            )}
            {state.kind === "article" && (
              <div className={HELP_PROSE} dangerouslySetInnerHTML={{ __html: state.html }} />
            )}
          </div>
          <div className="border-t border-black/10 px-4 py-3 text-sm">
            <Link href="/app/help" onClick={close} className="text-brand-blue underline">
              All help articles
            </Link>
          </div>
        </aside>
      )}
    </>
  );
}
