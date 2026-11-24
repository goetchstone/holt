// /app/__tests__/ticketPublicAuthor.test.ts
//
// The customer's ticket page names no member of staff
// (lib/tickets/publicAuthor.ts). A staff upload records the staff member's
// login email as the file's uploader, and the public status JSON sent it to
// anyone holding the ticket's link, beside messages it already signed
// "Support". The real routes run against Postgres in
// integration/ticketAttachmentLinks.integration.test.ts.

import {
  PUBLIC_STAFF_NAME,
  customerUploaderName,
  publicUploaderName,
} from "@/lib/tickets/publicAuthor";

const dana = { submitterName: "Dana Client", customer: null };

describe("customerUploaderName", () => {
  it("is the name the customer gave, else their customer record's, else Customer", () => {
    expect(customerUploaderName(dana)).toBe("Dana Client");
    expect(
      customerUploaderName({
        submitterName: null,
        customer: { firstName: "Ada", lastName: "Lane" },
      }),
    ).toBe("Ada Lane");
    expect(
      customerUploaderName({ submitterName: "", customer: { firstName: "Ada", lastName: null } }),
    ).toBe("Ada");
    expect(customerUploaderName({ submitterName: null, customer: null })).toBe("Customer");
  });
});

describe("publicUploaderName", () => {
  it("shows the customer's own upload under the name it recorded", () => {
    expect(publicUploaderName("Dana Client", dana)).toBe("Dana Client");
    const linked = { submitterName: null, customer: { firstName: "Ada", lastName: "Lane" } };
    expect(publicUploaderName("Ada Lane", linked)).toBe("Ada Lane");
    expect(publicUploaderName("Customer", { submitterName: null, customer: null })).toBe(
      "Customer",
    );
  });

  it.each([["sam.staff@example.com"], [null], ["Dana"], ["dana client"], [""]])(
    "shows an uploader recorded as %j as Support",
    (uploadedBy) => {
      expect(publicUploaderName(uploadedBy, dana)).toBe(PUBLIC_STAFF_NAME);
    },
  );
});
