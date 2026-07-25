import { authProvidersResponseSchema, type AuthProvider } from "@omnifin/contracts/auth";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { connectorConfigs, oidcProviders } from "../db/schema.js";

export const authProviderRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/auth/providers",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["providers"],
            properties: {
              providers: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "id",
                        "kind",
                        "displayName",
                        "issuer",
                        "state",
                        "jitProvisioningEnabled",
                        "supportsRpInitiatedLogout",
                        "supportsFrontChannelLogout",
                        "supportsBackChannelLogout",
                      ],
                      properties: {
                        id: { type: "string" },
                        kind: { const: "oidc" },
                        displayName: { type: "string" },
                        issuer: { type: "string" },
                        state: { enum: ["available", "unavailable", "misconfigured"] },
                        jitProvisioningEnabled: { type: "boolean" },
                        supportsRpInitiatedLogout: { type: "boolean" },
                        supportsFrontChannelLogout: { type: "boolean" },
                        supportsBackChannelLogout: { type: "boolean" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "id",
                        "kind",
                        "displayName",
                        "state",
                        "passwordLoginAvailable",
                        "quickConnectAvailable",
                        "pairingRequiredAfterOidc",
                      ],
                      properties: {
                        id: { type: "string" },
                        kind: { const: "jellyfin" },
                        displayName: { type: "string" },
                        state: { enum: ["available", "unavailable", "misconfigured"] },
                        passwordLoginAvailable: { type: "boolean" },
                        quickConnectAvailable: { type: "boolean" },
                        pairingRequiredAfterOidc: { const: true },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      const configuredOidc = app.database.db
        .select({
          allowJitProvisioning: oidcProviders.allowJitProvisioning,
          displayName: oidcProviders.displayName,
          id: oidcProviders.id,
          issuer: oidcProviders.issuer,
        })
        .from(oidcProviders)
        .where(eq(oidcProviders.enabled, true))
        .all();

      const providers: AuthProvider[] = configuredOidc.map((provider) => ({
        displayName: provider.displayName,
        id: provider.id,
        issuer: provider.issuer,
        jitProvisioningEnabled: provider.allowJitProvisioning,
        kind: "oidc",
        state: "unavailable",
        supportsBackChannelLogout: false,
        supportsFrontChannelLogout: false,
        supportsRpInitiatedLogout: false,
      }));

      const configuredJellyfin = app.database.db
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.type, "jellyfin"))
        .get();
      if (configuredJellyfin || app.appConfig.jellyfinUrl) {
        providers.push({
          displayName: "Jellyfin",
          id: "jellyfin",
          kind: "jellyfin",
          pairingRequiredAfterOidc: true,
          passwordLoginAvailable: false,
          quickConnectAvailable: false,
          state: "unavailable",
        });
      }

      return authProvidersResponseSchema.parse({ providers });
    },
  );
};
