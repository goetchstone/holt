// /app/__tests__/clientActionChip.test.ts
//
// These chips show on App Router screens. Copied across still using next/router, they
// crashed My Clients with "NextRouter was not mounted", which only a browser saw. This
// renders them with only next/navigation's router available, as those screens have.

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientContactChips } from "@/components/pipeline/ClientActionChip";

const render = (phone: string | null, email: string | null) =>
  renderToStaticMarkup(createElement(ClientContactChips, { customerId: 7, phone, email }));

describe("ClientContactChips", () => {
  it("renders with the App Router's router, and offers the client's profile", () => {
    const html = render("202-555-0143", "pat@example.com");
    expect(html).toContain("202-555-0143");
    expect(html).toContain("pat@example.com");
    expect(html).toContain("Client profile");
  });

  it("leaves out what the client doesn't have", () => {
    const html = render(null, null);
    expect(html).not.toContain("@");
    expect(html).toContain("Client profile");
  });
});
