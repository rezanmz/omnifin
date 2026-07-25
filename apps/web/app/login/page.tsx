import type { Metadata } from "next";
import { LoginScreen, type LoginProvider } from "../../components/login-screen";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const demoProviders: LoginProvider[] = [
  { id: "authentik", label: "Continue with Authentik", slug: "authentik", type: "oidc" },
  { id: "jellyfin", label: "Continue with Jellyfin", slug: "jellyfin", type: "jellyfin" },
];

interface LoginPageProperties {
  searchParams: Promise<{ "test-profile"?: string; "test-view"?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProperties) {
  const testParameters = process.env.OMNIFIN_TEST_MODE === "true" ? await searchParams : {};
  const requestedTestView = testParameters["test-view"];
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    testParameters["test-profile"] === "ten-foot"
      ? "ten-foot"
      : "standard";
  const providers =
    requestedTestView === "unconfigured" || process.env.OMNIFIN_DEMO_MODE !== "true"
      ? []
      : demoProviders;

  return <LoginScreen displayProfile={displayProfile} providers={providers} />;
}
