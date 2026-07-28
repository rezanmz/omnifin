import { type NextRequest, NextResponse } from "next/server";

export function onboardingRewriteTarget(request: NextRequest) {
  if (request.nextUrl.pathname !== "/" || (request.method !== "GET" && request.method !== "HEAD")) {
    return undefined;
  }

  const requestedByTestProfile =
    process.env.OMNIFIN_TEST_MODE === "true" &&
    request.nextUrl.searchParams.get("test-view") === "onboarding";
  if (!requestedByTestProfile) return undefined;

  const target = request.nextUrl.clone();
  const testProfile = request.nextUrl.searchParams.get("test-profile");
  target.pathname = "/onboarding";
  target.search = testProfile === "ten-foot" ? "?test-profile=ten-foot" : "";
  return target;
}

export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const developmentScriptSource = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const requestIsSecure = forwardedProtocol === "https" || request.nextUrl.protocol === "https:";
  const connectionSources =
    process.env.NODE_ENV === "development"
      ? "connect-src 'self' ws://127.0.0.1:* ws://localhost:*"
      : "connect-src 'self'";
  const contentSecurityPolicyDirectives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentScriptSource}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    connectionSources,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  if (requestIsSecure) {
    contentSecurityPolicyDirectives.push("upgrade-insecure-requests");
  }

  const contentSecurityPolicy = contentSecurityPolicyDirectives.join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", contentSecurityPolicy);
  requestHeaders.set("x-nonce", nonce);

  const onboardingTarget = onboardingRewriteTarget(request);
  const response = onboardingTarget
    ? NextResponse.rewrite(onboardingTarget, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", contentSecurityPolicy);
  response.headers.set(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  if (requestIsSecure) {
    response.headers.set(
      "strict-transport-security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)"],
};
