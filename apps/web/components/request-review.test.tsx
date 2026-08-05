import type { RequestReviewItem } from "@omnifin/contracts/requests";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RequestReviewClient, RequestReviewLoadOutcome } from "../lib/request-review";
import {
  demoRequestReviews,
  emptyRequestReviewOutcome,
  readyRequestReviewOutcome,
} from "../lib/request-review-demo";
import { RequestReview } from "./request-review";
import { ThemeProvider } from "./theme-provider";

const ready = readyRequestReviewOutcome as Extract<RequestReviewLoadOutcome, { status: "ready" }>;

function testClient(overrides: Partial<RequestReviewClient> = {}): RequestReviewClient {
  return {
    list: async (query) => ({ ...ready.snapshot.page, status: query.status }),
    load: async () => ready,
    review: async (requestId, input) => {
      const item = demoRequestReviews.find((request) => request.id === requestId)!;
      return {
        replayed: false,
        request: {
          ...item,
          status: input.decision === "approve" ? "approved" : "declined",
          updatedAt: "2026-07-28T16:21:00.000Z",
        },
      };
    },
    ...overrides,
  };
}

function renderReview(
  outcome: RequestReviewLoadOutcome = ready,
  client: RequestReviewClient = testClient(),
) {
  return render(
    <ThemeProvider initialPreference="system">
      <RequestReview client={client} initialOutcome={outcome} />
    </ThemeProvider>,
  );
}

describe("RequestReview", () => {
  it("renders pending normalized requests without upstream identifiers", () => {
    renderReview();

    expect(
      screen.getByRole("heading", { level: 1, name: "Decide what enters the library." }),
    ).toBeVisible();
    expect(screen.getByText("A House of Dynamite")).toBeVisible();
    expect(screen.getByText("Profile 4K Opt-in")).toBeVisible();
    expect(screen.getByText("Requested by Mara Chen")).toBeVisible();
    expect(screen.getByText("Secret boundary intact")).toBeVisible();
    expect(document.body.textContent).not.toContain("operator-external");
    expect(document.body.textContent).not.toContain("1234821");
  });

  it("switches between pending and historical decisions", async () => {
    const user = userEvent.setup();
    renderReview();

    expect(screen.queryByText("The Phoenician Scheme")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("The Phoenician Scheme")).toBeVisible();
    expect(screen.getByText("Foundation")).toBeVisible();
  });

  it("confirms an approval before writing it with one idempotent mutation", async () => {
    const user = userEvent.setup();
    const review = vi.fn(testClient().review);
    renderReview(ready, testClient({ review }));
    const card = screen.getByText("A House of Dynamite").closest("article");
    expect(card).not.toBeNull();

    await user.click(within(card!).getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog", { name: "Send this into acquisition?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve request" }));

    await waitFor(() => expect(review).toHaveBeenCalledOnce());
    expect(review.mock.calls[0]?.[0]).toBe("request:184");
    expect(review.mock.calls[0]?.[1]).toEqual({ decision: "approve" });
    expect(review.mock.calls[0]?.[2].csrfToken).toBe(ready.snapshot.csrfToken);
    expect(screen.getByRole("status")).toHaveTextContent("A House of Dynamite was approved.");
    expect(screen.queryByText("A House of Dynamite")).not.toBeInTheDocument();
  });

  it("keeps a failed decision open with a safe retry path", async () => {
    const user = userEvent.setup();
    const review = vi.fn(async (): Promise<{ replayed: boolean; request: RequestReviewItem }> => {
      throw new Error("Seerr is taking longer than expected. No outcome was assumed.");
    });
    renderReview(ready, testClient({ review }));
    const card = screen.getByText("The Eternaut").closest("article");

    await user.click(within(card!).getByRole("button", { name: "Decline" }));
    await user.click(screen.getByRole("button", { name: "Decline request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No outcome was assumed");
    expect(screen.getByRole("dialog", { name: "Close this request?" })).toBeVisible();
  });

  it("provides accessible light, dark, and system appearance controls", async () => {
    const user = userEvent.setup();
    renderReview();

    await user.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Dark theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    await user.keyboard("{End}");
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "System theme" })).toHaveFocus();
      expect(document.documentElement).toHaveAttribute("data-theme-preference", "system");
    });
  });

  it("renders empty and protected boundaries honestly", () => {
    const { unmount } = renderReview(emptyRequestReviewOutcome);
    expect(screen.getByRole("heading", { name: "No requests in this view." })).toBeVisible();

    unmount();
    renderReview({ status: "forbidden" });
    expect(screen.getByRole("heading", { name: "Operator access required." })).toBeVisible();
  });
});
