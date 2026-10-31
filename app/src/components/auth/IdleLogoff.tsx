"use client";

// /app/src/components/auth/IdleLogoff.tsx
//
// GAP-27, the screen half of automatic sign-out (rules in lib/auth/idleLogoff.ts).
// Mounted once in the back-office shell. While someone is signed in and the
// store hasn't turned it off, it:
//   - notes a person at the screen (typing, tapping, the mouse), shared across
//     the browser's tabs, so working in one tab keeps the others signed in;
//   - reports that to the server at most once a minute (the session "update"
//     call; lib/auth/sessionToken.ts restarts the token's idle time on it);
//   - a minute before the idle time runs out, asks "Still there?";
//   - then signs out (lib/auth/endSession.ts, which makes it stick), returning
//     to the sign-in screen and, after sign-in, to the screen they were on.
// A tab whose session ends elsewhere (signed out in another tab) leaves for
// the sign-in screen too, rather than going on showing what was on it.
//
// The server enforces the same deadline on its own, so closing the laptop or
// the tab doesn't keep a session alive.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { Button } from "@/components/ui/button";
import {
  IDLE_LOGOFF_OFF,
  formatCountdown,
  idlePhase,
  pingDue,
  sessionIdleMinutes,
} from "@/lib/auth/idleLogoff";
import { leaveTo, signOutTo } from "@/lib/auth/endSession";

const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;
/** The latest activity in any of this browser's tabs (localStorage). */
const SHARED_INPUT_KEY = "holt:lastInput";
const SHARE_EVERY_MS = 1_000;
const TICK_MS = 1_000;

function readSharedInput(): number {
  try {
    return Number(window.localStorage.getItem(SHARED_INPUT_KEY)) || 0;
  } catch {
    return 0;
  }
}

function shareInput(at: number): void {
  try {
    window.localStorage.setItem(SHARED_INPUT_KEY, String(at));
  } catch {
    // Private mode or blocked storage: this tab still times itself.
  }
}

/** The sign-in screen, coming back here afterwards. */
function signInUrl(idle: boolean): string {
  const back = encodeURIComponent(window.location.pathname + window.location.search);
  return `/auth/login?${idle ? "reason=idle&" : ""}callbackUrl=${back}`;
}

export function IdleLogoff() {
  const { data: session, status, update } = useSession();
  const idleMinutes = sessionIdleMinutes(session);
  // Keyed on the session, not the status: next-auth reports "loading" while each
  // activity report is in flight, with the session still there.
  const enabled = session != null && idleMinutes !== IDLE_LOGOFF_OFF;

  // This tab's own latest activity; loading the page counts (set when timing starts).
  const ownInput = useRef(0);
  const lastPing = useRef(0);
  const lastShared = useRef(0);
  const leaving = useRef(false);
  const wasSignedIn = useRef(false);
  const updateRef = useRef(update);
  const [warningMs, setWarningMs] = useState<number | null>(null);

  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  const latestInput = useCallback(() => Math.max(ownInput.current, readSharedInput()), []);

  const report = useCallback(() => {
    const now = Date.now();
    if (!pingDue({ now, lastInput: ownInput.current, lastPing: lastPing.current })) return;
    lastPing.current = now;
    // next-auth skips an update while another session read is in flight, and
    // answers nothing then; the next activity tries again.
    const retry = () => {
      lastPing.current = 0;
    };
    updateRef.current({ active: true }).then((s) => s || retry(), retry);
  }, []);

  const noteInput = useCallback(() => {
    const now = Date.now();
    ownInput.current = now;
    if (now - lastShared.current >= SHARE_EVERY_MS) {
      lastShared.current = now;
      shareInput(now);
    }
    report();
  }, [report]);

  const leave = useCallback((idle: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    void signOutTo(signInUrl(idle));
  }, []);

  // Signed out elsewhere: go to the sign-in screen instead of going on showing this one.
  useEffect(() => {
    if (status === "authenticated") wasSignedIn.current = true;
    if (status === "unauthenticated" && wasSignedIn.current && !leaving.current) {
      leaving.current = true;
      const idle =
        idlePhase({ now: Date.now(), lastInput: latestInput(), idleMinutes }).phase === "expired";
      leaveTo(signInUrl(idle));
    }
  }, [status, idleMinutes, latestInput]);

  useEffect(() => {
    if (!enabled) return;
    // Loading the page counts as activity, and its report goes at once.
    if (ownInput.current === 0) ownInput.current = Date.now();
    const tick = () => {
      const phase = idlePhase({ now: Date.now(), lastInput: latestInput(), idleMinutes });
      if (phase.phase === "expired") leave(true);
      setWarningMs(phase.phase === "warning" ? phase.msLeft : null);
    };
    for (const name of ACTIVITY_EVENTS) {
      document.addEventListener(name, noteInput, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", tick);
    const timer = window.setInterval(tick, TICK_MS);
    report();
    tick();
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        document.removeEventListener(name, noteInput, { capture: true });
      }
      document.removeEventListener("visibilitychange", tick);
      window.clearInterval(timer);
    };
  }, [enabled, idleMinutes, latestInput, leave, noteInput, report]);

  if (!enabled || warningMs === null) return null;
  return (
    <Dialog open onClose={noteInput} className="relative z-[60]">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-md rounded-2xl bg-white p-6 font-serif shadow-xl">
          <DialogTitle as="h3" className="mb-3 text-xl font-semibold text-brand-blue">
            Still there?
          </DialogTitle>
          <p className="text-sm text-brand-black">
            Nothing has happened in Holt for a while. You&apos;ll be signed out in{" "}
            <span className="font-semibold tabular-nums">{formatCountdown(warningMs)}</span> so the
            next person here can&apos;t carry on as you.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => leave(false)}>
              Sign out now
            </Button>
            <Button variant="primary" onClick={noteInput}>
              Stay signed in
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
