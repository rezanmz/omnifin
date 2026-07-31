import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RecoveryPage from "./page";

describe("RecoveryPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exposes deterministic recovery states only in the browser test profile", async () => {
    vi.stubEnv("OMNIFIN_TEST_MODE", "true");
    render(await RecoveryPage({ searchParams: Promise.resolve({ "test-view": "bootstrap" }) }));

    expect(screen.getByRole("heading", { name: "Establish trusted control." })).toBeVisible();
    expect(screen.queryByLabelText("Recovery secret")).not.toBeInTheDocument();
  });

  it("ignores test-view parameters outside the browser test profile", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ csrfToken: null, principal: null }));
    render(await RecoveryPage({ searchParams: Promise.resolve({ "test-view": "bootstrap" }) }));

    expect(await screen.findByLabelText("Recovery secret")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
  });
});
