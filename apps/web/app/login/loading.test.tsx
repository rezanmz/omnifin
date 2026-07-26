import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginLoading from "./loading";

afterEach(() => vi.unstubAllEnvs());

describe("LoginLoading", () => {
  it.each([
    ["standard", "standard"],
    ["ten-foot", "ten-foot"],
  ] as const)("uses the %s deployment display profile", (environmentValue, expected) => {
    vi.stubEnv("OMNIFIN_DISPLAY_PROFILE", environmentValue);
    const { container } = render(<LoginLoading />);

    expect(container.firstElementChild).toHaveAttribute("data-display-profile", expected);
    expect(container.querySelector("main")).toHaveAttribute("aria-busy", "true");
  });
});
