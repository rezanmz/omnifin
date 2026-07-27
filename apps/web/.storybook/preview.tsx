import type { Preview } from "@storybook/nextjs-vite";

import "../app/globals.css";
import { ThemeProvider } from "../components/theme-provider";
import type { ThemePreference } from "../lib/theme";

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const preference = (context.globals.theme ?? "dark") as ThemePreference;
      return (
        <ThemeProvider initialPreference={preference} key={preference}>
          <Story />
        </ThemeProvider>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        icon: "paintbrush",
        items: [
          { title: "Dark", value: "dark" },
          { title: "Light", value: "light" },
          { title: "System", value: "system" },
        ],
      },
    },
  },
  initialGlobals: { theme: "dark" },
  parameters: {
    a11y: { test: "error" },
    backgrounds: { default: "omnifin" },
    controls: { expanded: true },
    layout: "fullscreen",
    options: { storySort: { order: ["Foundation", "Components", "Screens"] } },
  },
};

export default preview;
