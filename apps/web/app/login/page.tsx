import type { AuthProvider } from "@omnifin/contracts/auth";
import type { Metadata } from "next";
import { LoginScreen, type LoginAuthError } from "../../components/login-screen";
import { loadCachedPublicAuthProviders } from "../../lib/auth-providers";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const knownAuthErrors = new Set<LoginAuthError>([
  "account_not_authorized",
  "authentication_failed",
  "authorization_denied",
  "invalid_request",
  "provider_unavailable",
  "session_limit_reached",
]);

const demoProviders: readonly AuthProvider[] = [
  {
    displayName: "Authentik",
    id: "authentik",
    issuer: "https://identity.example.test/application/o/omnifin/",
    jitProvisioningEnabled: true,
    kind: "oidc",
    state: "available",
    supportsBackChannelLogout: true,
    supportsFrontChannelLogout: true,
    supportsRpInitiatedLogout: true,
  },
  {
    displayName: "Jellyfin",
    id: "jellyfin",
    kind: "jellyfin",
    pairingRequiredAfterOidc: true,
    passwordLoginAvailable: true,
    quickConnectAvailable: true,
    state: "available",
  },
];

const maximumProviderDisplayName = `Identity ${"A".repeat(151)}`;
const overflowProviders: readonly AuthProvider[] = Array.from({ length: 50 }, (_, index) => ({
  ...demoProviders[0]!,
  displayName: index === 0 ? maximumProviderDisplayName : `Identity provider ${index + 1}`,
  id: `overflow-identity-${index + 1}`,
  state: index === 24 ? ("misconfigured" as const) : ("available" as const),
}));

interface LoginPageProperties {
  searchParams: Promise<{
    authError?: string | string[];
    "test-profile"?: string | string[];
    "test-view"?: string | string[];
  }>;
}

function singleParameter(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeAuthError(value: string | string[] | undefined): LoginAuthError | undefined {
  const candidate = singleParameter(value);
  return candidate && knownAuthErrors.has(candidate as LoginAuthError)
    ? (candidate as LoginAuthError)
    : undefined;
}

export default async function LoginPage({ searchParams }: LoginPageProperties) {
  const parameters = await searchParams;
  const testMode = process.env.OMNIFIN_TEST_MODE === "true";
  const requestedTestView = testMode ? singleParameter(parameters["test-view"]) : undefined;
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ||
    (testMode && singleParameter(parameters["test-profile"]) === "ten-foot")
      ? "ten-foot"
      : "standard";

  const providerResult =
    process.env.OMNIFIN_DEMO_MODE === "true"
      ? ({ providers: demoProviders, status: "ready" } as const)
      : await loadCachedPublicAuthProviders({
          gatewayUrl: process.env.OMNIFIN_GATEWAY_URL ?? "http://127.0.0.1:4000",
        });
  const visibleResult =
    requestedTestView === "unconfigured"
      ? ({ providers: [], status: "ready" } as const)
      : requestedTestView === "unavailable"
        ? ({ providers: [], status: "unavailable" } as const)
        : requestedTestView === "provider-overflow"
          ? ({ providers: overflowProviders, status: "ready" } as const)
          : providerResult;
  const authError = safeAuthError(parameters.authError);

  return (
    <LoginScreen
      {...(authError === undefined ? {} : { authError })}
      displayProfile={displayProfile}
      providerLoadState={visibleResult.status}
      providers={visibleResult.providers}
    />
  );
}
