import type { Preview } from "@storybook/nextjs-vite";
import "../app/globals.css";

const preview: Preview = {
  parameters: {
    a11y: { test: "error" },
    backgrounds: { default: "omnifin" },
    controls: { expanded: true },
    layout: "fullscreen",
    options: { storySort: { order: ["Foundation", "Components", "Screens"] } },
  },
};

export default preview;
