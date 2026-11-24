// /app/__tests__/toastError.test.ts
//
// getErrorWarnings: the parser warnings an order-upload route sends with its 400
// when every line was left out (orderUploadNoLines.test.ts), read the same way
// from an axios error (the apparel tool) and a fetch body (the other pages).

import { AxiosError, type AxiosResponse } from "axios";
import { getErrorWarnings } from "@/lib/toastError";

const BODY = { error: "No line items found in PDF", warnings: ["Style A1: left out", 7, "x"] };

describe("getErrorWarnings", () => {
  it("reads the string warnings from an axios error's body", () => {
    const err = new AxiosError("Request failed with status code 400", "ERR_BAD_REQUEST");
    err.response = { data: BODY, status: 400 } as AxiosResponse;
    expect(getErrorWarnings(err)).toEqual(["Style A1: left out", "x"]);
  });

  it("reads them from a JSON body a fetch already read", () => {
    expect(getErrorWarnings(BODY)).toEqual(["Style A1: left out", "x"]);
  });

  it.each([
    ["a body without warnings", { error: "No file uploaded" }],
    ["warnings that are not a list", { warnings: "Style A1" }],
    ["no body", null],
    ["a plain Error", new Error("Network Error")],
    ["an axios error with no response", new AxiosError("Network Error")],
  ])("is empty for %s", (_label, input) => {
    expect(getErrorWarnings(input)).toEqual([]);
  });
});
