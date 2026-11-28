// /app/src/lib/pos/readerPanelShared.ts
//
// What the register's panel says and offers while a card payment is out on a
// reader (CardTenderNote in PosView.tsx), in the parts the screen and its test
// share. Client-safe.
//
// Owner, 2026-11-28, after the first test on a simulated reader: "I had a
// little delay so I may have hit a button more than once, perhaps we need a
// spinner to indicate processing". The panel's buttons gave no sign that a
// press had been taken, and the reader's answer comes seconds later, with the
// next ask. A second press of a test-card button went out meanwhile: the
// reader had finished, the processor refused it ("not currently processing a
// transaction"), and the screen showed that as an error beside a payment that
// had gone exactly as asked.
//
// The buttons keep their words and their places whatever this says: the line
// is shown under them (see the panel), so a second press can never land on a
// different button from the first.

/** What this screen is doing about the payment out on the reader. */
export interface ReaderPanelState {
  /** A press that is still on its way to the server. */
  busy?: "presenting" | "cancelling";
  /** A test card was presented: the reader's answer comes with the next ask. */
  presented?: boolean;
}

export interface ReaderPanelSays {
  /** What is happening, under the buttons; null while only waiting for the card. */
  line: string | null;
  canCancel: boolean;
  /** The two test-card buttons, on a simulated reader. One card per payment. */
  canPresent: boolean;
}

export function readerPanelSays(state: ReaderPanelState): ReaderPanelSays {
  if (state.busy === "cancelling") {
    return { line: "Cancelling it on the reader...", canCancel: false, canPresent: false };
  }
  if (state.busy === "presenting") {
    return { line: "Presenting the test card...", canCancel: false, canPresent: false };
  }
  if (state.presented) {
    // Still cancellable: the server says so when the card is already being
    // authorized and can't be stopped.
    return {
      line: "Card presented. Waiting for the reader's answer...",
      canCancel: true,
      canPresent: false,
    };
  }
  return { line: null, canCancel: true, canPresent: true };
}
