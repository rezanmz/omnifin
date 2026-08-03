import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import type * as NextNavigation from "next/navigation";
import { afterEach, vi } from "vitest";

vi.mock("next/navigation", async (importOriginal) => {
  const navigation = await importOriginal<typeof NextNavigation>();
  return {
    ...navigation,
    useRouter: () => ({ push: vi.fn() }),
  };
});

Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
  })),
});

afterEach(() => cleanup());
