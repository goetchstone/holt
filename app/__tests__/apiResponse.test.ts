// /app/__tests__/apiResponse.test.ts

import {
  ApiError,
  success,
  created,
  noContent,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  methodNotAllowed,
  handleError,
} from "../src/lib/apiResponse";

// Mock NextApiResponse
function mockRes() {
  const res: Record<string, jest.Mock> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
  };
  return res;
}

// ─── ApiError ───────────────────────────────────────────────────────

describe("ApiError", () => {
  it("creates an error with status code and message", () => {
    const err = new ApiError(400, "Bad input");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Bad input");
    expect(err.name).toBe("ApiError");
    expect(err).toBeInstanceOf(Error);
  });

  it("includes optional error code", () => {
    const err = new ApiError(409, "Already exists", "CONFLICT");
    expect(err.code).toBe("CONFLICT");
  });
});

// ─── Success responses ──────────────────────────────────────────────

describe("success", () => {
  it("sends 200 with data", () => {
    const res = mockRes();
    success(res as any, { id: 1, name: "Test" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id: 1, name: "Test" });
  });

  it("allows custom status code", () => {
    const res = mockRes();
    success(res as any, { ok: true }, 202);
    expect(res.status).toHaveBeenCalledWith(202);
  });
});

describe("created", () => {
  it("sends 201 with data", () => {
    const res = mockRes();
    created(res as any, { id: 42 });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: 42 });
  });
});

describe("noContent", () => {
  it("sends 204 with no body", () => {
    const res = mockRes();
    noContent(res as any);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});

// ─── Error responses ────────────────────────────────────────────────

describe("badRequest", () => {
  it("sends 400 with message and code", () => {
    const res = mockRes();
    badRequest(res as any, "Missing required field");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing required field",
      code: "BAD_REQUEST",
    });
  });
});

describe("unauthorized", () => {
  it("sends 401", () => {
    const res = mockRes();
    unauthorized(res as any);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unauthorized",
      code: "UNAUTHORIZED",
    });
  });
});

describe("forbidden", () => {
  it("sends 403 with default message", () => {
    const res = mockRes();
    forbidden(res as any);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forbidden",
      code: "FORBIDDEN",
    });
  });

  it("sends 403 with custom message", () => {
    const res = mockRes();
    forbidden(res as any, "Admin access required");
    expect(res.json).toHaveBeenCalledWith({
      error: "Admin access required",
      code: "FORBIDDEN",
    });
  });
});

describe("notFound", () => {
  it("sends 404 with default entity", () => {
    const res = mockRes();
    notFound(res as any);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: "Resource not found",
      code: "NOT_FOUND",
    });
  });

  it("sends 404 with custom entity name", () => {
    const res = mockRes();
    notFound(res as any, "Product");
    expect(res.json).toHaveBeenCalledWith({
      error: "Product not found",
      code: "NOT_FOUND",
    });
  });
});

describe("conflict", () => {
  it("sends 409 with message", () => {
    const res = mockRes();
    conflict(res as any, "Email already registered");
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Email already registered",
      code: "CONFLICT",
    });
  });
});

describe("methodNotAllowed", () => {
  it("sends 405 with Allow header", () => {
    const res = mockRes();
    methodNotAllowed(res as any, ["GET", "POST"]);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", ["GET", "POST"]);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({
      error: "Method not allowed. Use: GET, POST",
      code: "METHOD_NOT_ALLOWED",
    });
  });
});

// ─── handleError ────────────────────────────────────────────────────

// handleError now routes through logger.error (via logError) per
// CLAUDE.md rule 13. Mock the logger module so the tests can assert the
// call shape without spamming real stdout.
jest.mock("@/lib/logger", () => ({
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
import { logError as mockedLogError } from "@/lib/logger";

describe("handleError", () => {
  beforeEach(() => {
    (mockedLogError as jest.Mock).mockClear();
  });

  it("handles ApiError by returning its status and message", () => {
    const res = mockRes();
    const err = new ApiError(422, "Validation failed", "VALIDATION_ERROR");
    handleError(res as any, err);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
    });
  });

  it("handles standard Error as 500", () => {
    const res = mockRes();
    handleError(res as any, new Error("Something broke"));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Something broke",
      code: "INTERNAL_ERROR",
    });
  });

  it("handles non-Error objects as 500", () => {
    const res = mockRes();
    handleError(res as any, "string error");
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  });

  it("logs with context when provided", () => {
    const res = mockRes();
    const err = new Error("fail");
    handleError(res as any, err, "ProductCreate");
    expect(mockedLogError).toHaveBeenCalledWith("ProductCreate", err);
  });

  it("logs a default message when no context is provided", () => {
    const res = mockRes();
    const err = new Error("fail");
    handleError(res as any, err);
    expect(mockedLogError).toHaveBeenCalledWith("Unhandled API error", err);
  });

  it("does not log ApiError (it's already shaped for the client)", () => {
    const res = mockRes();
    handleError(res as any, new ApiError(400, "Bad"));
    expect(mockedLogError).not.toHaveBeenCalled();
  });
});
