// /app/__tests__/readerPanelShared.test.ts
//
// The register's panel while a card payment is out on a reader: what it says
// is happening, and which buttons can be pressed (lib/pos/readerPanelShared.ts).
// A button that gave no sign of a press was pressed twice on the first test
// run, and the second press reached the processor as an error.

import { readerPanelSays } from "@/lib/pos/readerPanelShared";

describe("the panel while a card payment is out on a reader", () => {
  it("only waits for the card at first: cancel and the test cards are offered", () => {
    expect(readerPanelSays({})).toEqual({ line: null, canCancel: true, canPresent: true });
  });

  it("takes one press at a time while a test card is being presented", () => {
    expect(readerPanelSays({ busy: "presenting" })).toEqual({
      line: "Presenting the test card...",
      canCancel: false,
      canPresent: false,
    });
  });

  it("offers no second card once one has been presented, and can still be cancelled", () => {
    // The reader's answer comes seconds later; a second card then reaches a
    // reader that has finished, which the processor refuses.
    expect(readerPanelSays({ presented: true })).toEqual({
      line: "Card presented. Waiting for the reader's answer...",
      canCancel: true,
      canPresent: false,
    });
  });

  it("says it is cancelling, and takes nothing else meanwhile", () => {
    expect(readerPanelSays({ busy: "cancelling" })).toEqual({
      line: "Cancelling it on the reader...",
      canCancel: false,
      canPresent: false,
    });
    // A cancel pressed after a card was presented is still the cancel in flight.
    expect(readerPanelSays({ busy: "cancelling", presented: true })).toEqual({
      line: "Cancelling it on the reader...",
      canCancel: false,
      canPresent: false,
    });
  });

  it("goes back to what it was when a cancel could not stop a presented card", () => {
    // The press is over (no busy), the card was presented: no second card.
    expect(readerPanelSays({ busy: undefined, presented: true })).toEqual({
      line: "Card presented. Waiting for the reader's answer...",
      canCancel: true,
      canPresent: false,
    });
  });
});
