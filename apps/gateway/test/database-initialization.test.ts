import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => ({
  close: vi.fn<() => void>(),
  initializationError: new Error("fixture database initialization failure"),
}));

vi.mock("better-sqlite3", () => ({
  default: class DatabaseMock {
    close() {
      databaseMock.close();
    }

    pragma() {
      throw databaseMock.initializationError;
    }
  },
}));

import { openDatabase } from "../src/db/client.js";
import { StartupError, startupFailureDetails } from "../src/startup-error.js";

describe("database initialization cleanup", () => {
  beforeEach(() => {
    databaseMock.close.mockReset();
  });

  it("closes a constructed database when post-construction initialization fails", () => {
    let failure: unknown;
    try {
      openDatabase(":memory:");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(StartupError);
    expect((failure as Error).cause).toBe(databaseMock.initializationError);
    expect(startupFailureDetails(failure)).toEqual({
      category: "database",
      code: "database_initialization_failed",
    });
    expect(databaseMock.close).toHaveBeenCalledOnce();
  });

  it("preserves initialization and cleanup failures", () => {
    const cleanupError = new Error("fixture database cleanup failure");
    databaseMock.close.mockImplementationOnce(() => {
      throw cleanupError;
    });

    let failure: unknown;
    try {
      openDatabase(":memory:");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const [initializationFailure, preservedCleanupError] = (failure as AggregateError).errors;
    expect(initializationFailure).toBeInstanceOf(StartupError);
    expect((initializationFailure as Error).cause).toBe(databaseMock.initializationError);
    expect(preservedCleanupError).toBe(cleanupError);
    expect(startupFailureDetails(failure)).toEqual({
      category: "database",
      code: "database_initialization_failed",
    });
    expect((failure as AggregateError).message).toBe(
      "Database initialization failed and cleanup did not complete.",
    );
  });
});
