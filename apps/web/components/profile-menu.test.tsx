import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ProfileMenu } from "./profile-menu";
import { ThemeProvider } from "./theme-provider";

describe("ProfileMenu", () => {
  it("opens appearance controls and returns focus after Escape", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider initialPreference="dark">
        <ProfileMenu />
      </ThemeProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Open profile menu" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Profile and appearance" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /dark/i })).toBeChecked();
    expect(screen.getByRole("link", { name: /account & access/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByRole("link", { name: /playback preferences/i })).toHaveAttribute(
      "href",
      "/settings/playback",
    );
    expect(screen.getByRole("link", { name: /about omnifin/i })).toHaveAttribute("href", "/about");

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Profile and appearance" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes after a pointer interaction outside the popover", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ProfileMenu />
        <button type="button">Outside</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Open profile menu" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(
      screen.queryByRole("dialog", { name: "Profile and appearance" }),
    ).not.toBeInTheDocument();
  });
});
