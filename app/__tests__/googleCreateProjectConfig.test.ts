/**
 * VAL-04 — the Google project-creation route reads its Drive folder and Slides
 * template from AppSettings (Admin → Settings → Integrations), never from
 * hardcoded ids. When either is unset the route refuses with 503 rather than
 * writing customer project folders into whichever Drive a baked-in id pointed
 * at.
 *
 * Fails against the old code: the original route defined ROOT_FOLDER_ID and
 * TEMPLATE_PRESENTATION_ID as string literals, so it could never return 503 and
 * always attempted the Drive write with the pilot's folder/template. Reintroduce
 * the literals and the two 503 cases return 200 and the third routes the wrong
 * ids.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { handler } from "@/pages/api/google/create-project";
import type { ResolvedAppSettings } from "@/lib/appSettings";

// Keep the Google client off the network; let the success case resolve deterministically.
const mockFilesCreate = jest.fn();
const mockFilesCopy = jest.fn();
jest.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })) },
    drive: jest.fn(() => ({ files: { create: mockFilesCreate, copy: mockFilesCopy } })),
  },
}));
jest.mock("@/lib/logger", () => ({ logError: jest.fn() }));

// Drive/Slides config comes from AppSettings; override only getAppSettings.
const mockGetAppSettings = jest.fn();
jest.mock("@/lib/appSettings", () => ({
  ...jest.requireActual("@/lib/appSettings"),
  getAppSettings: () => mockGetAppSettings(),
}));

type GoogleConfig = ResolvedAppSettings["google"];
function googleSettings(
  overrides: { root?: string | null; template?: string | null; subfolders?: string[] } = {},
): GoogleConfig {
  return {
    drive: {
      projectsRootFolderId: overrides.root ?? null,
      projectSubfolders: overrides.subfolders ?? [
        "Windows",
        "Rugs",
        "Fabrics",
        "Furniture",
        "Photos",
        "Presentation",
      ],
    },
    slides: { templatePresentationId: overrides.template ?? null },
  };
}

function makeRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: jest.Mock;
    json: jest.Mock;
  } = {
    statusCode: 0,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: { error?: string } };
}

const session = { accessToken: "tok", user: { email: "admin@example.com" } } as unknown as Session;
const postReq = () =>
  ({ method: "POST", body: { customerLastName: "Smith" } }) as unknown as NextApiRequest;

describe("VAL-04 google/create-project AppSettings config", () => {
  beforeEach(() => {
    mockFilesCreate.mockReset();
    mockFilesCopy.mockReset();
    mockGetAppSettings.mockReset();
  });

  it("refuses with 503 when neither the folder nor the template is configured", async () => {
    mockGetAppSettings.mockResolvedValue({ google: googleSettings() });
    const res = makeRes();
    await handler(postReq(), res, session);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Settings → Integrations/);
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it("refuses with 503 when only the root folder is set (template missing)", async () => {
    mockGetAppSettings.mockResolvedValue({ google: googleSettings({ root: "root-123" }) });
    const res = makeRes();
    await handler(postReq(), res, session);
    expect(res.statusCode).toBe(503);
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it("routes the configured folder + template into the Drive calls when both are set", async () => {
    mockGetAppSettings.mockResolvedValue({
      google: googleSettings({ root: "root-XYZ", template: "template-XYZ" }),
    });
    // main folder create, then one create per subfolder (Presentation included), then the copy.
    mockFilesCreate
      .mockResolvedValueOnce({ data: { id: "main-folder" } })
      .mockResolvedValue({ data: { id: "sub" } });
    mockFilesCopy.mockResolvedValueOnce({ data: { id: "copied-deck" } });

    const res = makeRes();
    await handler(postReq(), res, session);

    expect(res.statusCode).toBe(200);
    // main project folder parented under the configured root, not a baked-in literal
    expect(mockFilesCreate.mock.calls[0][0].requestBody.parents).toEqual(["root-XYZ"]);
    // deck copied from the configured template
    expect(mockFilesCopy.mock.calls[0][0].fileId).toBe("template-XYZ");
  });
});
