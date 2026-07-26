import type { FastifyInstance, FastifyRequest } from "fastify";
import { SafeHttpError } from "../http-error.js";

export type MutationSecurityPolicy =
  | { kind: "oidc-backchannel" }
  | { kind: "public-browser" }
  | { kind: "session" }
  | { kind: "session-form" };

declare module "fastify" {
  interface FastifyContextConfig {
    omnifinSecurity?: MutationSecurityPolicy;
  }
}

function methods(value: string | string[]) {
  return Array.isArray(value) ? value : [value];
}

function isMutation(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export interface RequestPolicyOptions {
  allowedOrigin: string;
  validateOidcBackchannel?: (request: FastifyRequest) => boolean | Promise<boolean>;
  validateSessionCsrf?: (request: FastifyRequest) => boolean | Promise<boolean>;
}

export function installRequestPolicy(app: FastifyInstance, options: RequestPolicyOptions) {
  app.addHook("onRoute", (route) => {
    if (!methods(route.method).some(isMutation)) return;
    const policy = route.config?.omnifinSecurity;
    if (!policy) {
      throw new Error(`Mutation route ${route.url} must declare an Omnifin security policy.`);
    }
    if (!["oidc-backchannel", "public-browser", "session", "session-form"].includes(policy.kind)) {
      throw new Error(`Mutation route ${route.url} declares an unknown security policy.`);
    }
    if (
      policy.kind === "oidc-backchannel" &&
      (methods(route.method).some((method) => method.toUpperCase() !== "POST") ||
        route.url !== "/v1/auth/oidc/backchannel/:providerId")
    ) {
      throw new Error("OIDC back-channel authentication is limited to its dedicated POST route.");
    }
    if (
      policy.kind === "session-form" &&
      (methods(route.method).some((method) => method.toUpperCase() !== "POST") ||
        route.url !== "/v1/auth/oidc/logout")
    ) {
      throw new Error("Session form authentication is limited to the OIDC logout POST route.");
    }
  });

  app.addHook("onRequest", async (request) => {
    if (!isMutation(request.method)) return;
    const policy = request.routeOptions.config.omnifinSecurity;
    if (!policy) {
      throw new SafeHttpError({
        code: "request_policy_denied",
        message: "The request security policy is unavailable.",
        statusCode: 403,
      });
    }

    if (policy.kind === "oidc-backchannel") return;

    if (request.headers.origin !== options.allowedOrigin) {
      throw new SafeHttpError({
        code: "origin_denied",
        message: "The request origin is not allowed.",
        statusCode: 403,
      });
    }

    if (policy.kind === "session") {
      const csrfIsValid = await options.validateSessionCsrf?.(request);
      if (csrfIsValid) return;
      throw new SafeHttpError({
        code: "csrf_denied",
        message: "The request could not be verified.",
        statusCode: 403,
      });
    }
  });

  app.addHook("preValidation", async (request) => {
    if (!isMutation(request.method)) return;
    const policy = request.routeOptions.config.omnifinSecurity;
    if (policy?.kind === "session-form") {
      const csrfIsValid = await options.validateSessionCsrf?.(request);
      if (csrfIsValid) return;
      throw new SafeHttpError({
        code: "csrf_denied",
        message: "The request could not be verified.",
        statusCode: 403,
      });
    }
    if (policy?.kind === "oidc-backchannel") {
      const requestIsValid = await options.validateOidcBackchannel?.(request);
      if (requestIsValid) return;
      throw new SafeHttpError({
        code: "backchannel_authentication_denied",
        message: "The logout request could not be verified.",
        statusCode: 401,
      });
    }
  });
}
