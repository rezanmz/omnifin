import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LoginScreen } from "../components/login-screen";

const meta = {
  component: LoginScreen,
  parameters: { layout: "fullscreen" },
  title: "Screens/Login",
} satisfies Meta<typeof LoginScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configured: Story = {
  args: {
    providers: [
      { id: "authentik", label: "Continue with Authentik", slug: "authentik", type: "oidc" },
      { id: "jellyfin", label: "Continue with Jellyfin", slug: "jellyfin", type: "jellyfin" },
    ],
  },
};
export const Unconfigured: Story = { args: { providers: [] } };
export const TenFoot: Story = {
  args: {
    displayProfile: "ten-foot",
    providers: [
      { id: "authentik", label: "Continue with Authentik", slug: "authentik", type: "oidc" },
      { id: "jellyfin", label: "Continue with Jellyfin", slug: "jellyfin", type: "jellyfin" },
    ],
  },
};
