import { z } from "zod";

export const connectorServiceSchema = z.enum([
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
  "tmdb",
]);
export type ConnectorService = z.infer<typeof connectorServiceSchema>;

export const connectorCapabilitySchema = z.enum([
  "connector.health",
  "connector.version",
  "identity.authenticate",
  "identity.quick_connect",
  "media.discover",
  "media.library.read",
  "media.library.mutate",
  "media.playback",
  "media.watch_state",
  "request.create",
  "request.review",
  "acquisition.search",
  "acquisition.grab",
  "acquisition.history",
  "indexer.statistics",
  "indexer.test",
  "download.queue.read",
  "download.queue.mutate",
  "subtitle.search",
  "subtitle.download",
]);
export type ConnectorCapability = z.infer<typeof connectorCapabilitySchema>;

export const connectorFailureCodeSchema = z.enum([
  "configuration_invalid",
  "destination_blocked",
  "invalid_credentials",
  "rate_limited",
  "response_invalid",
  "timeout",
  "unreachable",
  "unsupported_version",
  "upstream_error",
]);
export type ConnectorFailureCode = z.infer<typeof connectorFailureCodeSchema>;

export const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export const partialFailureSchema = z.object({
  service: connectorServiceSchema,
  operation: z.string().trim().min(1).max(128),
  code: connectorFailureCodeSchema,
  message: z.string().trim().min(1).max(300),
  retryable: z.boolean(),
  occurredAt: z.iso.datetime({ offset: true }),
  retryAfterSeconds: z.int().nonnegative().max(MAX_RETRY_AFTER_SECONDS).optional(),
});
export type PartialFailure = z.infer<typeof partialFailureSchema>;

export const connectorHealthSchema = z
  .object({
    connectorId: z.string().trim().min(1).max(128),
    service: connectorServiceSchema,
    displayName: z.string().trim().min(1).max(160),
    status: z.enum(["healthy", "degraded", "unavailable", "misconfigured", "unknown"]),
    checkedAt: z.iso.datetime({ offset: true }),
    latencyMs: z.number().finite().nonnegative(),
    version: z.string().trim().min(1).max(128).nullable(),
    capabilities: z.array(connectorCapabilitySchema),
    failure: partialFailureSchema.nullable(),
  })
  .superRefine((health, context) => {
    if (new Set(health.capabilities).size !== health.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Connector capabilities cannot contain duplicates.",
      });
    }
    if (health.failure && health.failure.service !== health.service) {
      context.addIssue({
        code: "custom",
        path: ["failure", "service"],
        message: "Connector failures must identify the same service as their health record.",
      });
    }
    if (health.status === "healthy" && health.failure !== null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "A healthy connector cannot include a failure.",
      });
    }
    if (health.status !== "healthy" && health.status !== "unknown" && health.failure === null) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "A non-healthy connector must explain its failure.",
      });
    }
  });
export type ConnectorHealth = z.infer<typeof connectorHealthSchema>;

export const connectorSnapshotSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  overallStatus: z.enum(["healthy", "degraded", "unavailable", "unconfigured"]),
  connectors: z.array(connectorHealthSchema).max(100),
});
export type ConnectorSnapshot = z.infer<typeof connectorSnapshotSchema>;

export const managedConnectorServiceSchema = z.enum([
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "bazarr",
  "qbittorrent",
  "sabnzbd",
]);
export type ManagedConnectorService = z.infer<typeof managedConnectorServiceSchema>;

export const connectorTlsPolicySchema = z.enum(["strict", "allow_self_signed"]);
export type ConnectorTlsPolicy = z.infer<typeof connectorTlsPolicySchema>;

export const connectorIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

const connectorBaseUrlSchema = z
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Connector URLs must be HTTP(S) origins or base paths without credentials or suffixes.",
      });
    }
  });

const connectorSecretSchema = z.string().min(1).max(4_096);
const connectorTlsCaCertificatePemSchema = z
  .string()
  .min(1)
  .max(12_288)
  .refine(
    (value) =>
      /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/u.test(
        value,
      ),
    "A single PEM-encoded CA certificate is required.",
  );

export const connectorCredentialInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("api_key"), apiKey: connectorSecretSchema }),
  z.strictObject({
    kind: z.literal("username_password"),
    username: z.string().trim().min(1).max(256),
    password: connectorSecretSchema,
  }),
]);
export type ConnectorCredentialInput = z.infer<typeof connectorCredentialInputSchema>;

export const connectorCredentialKindSchema = z.enum(["none", "api_key", "username_password"]);
export type ConnectorCredentialKind = z.infer<typeof connectorCredentialKindSchema>;

function credentialKindAllowed(service: ManagedConnectorService, kind: ConnectorCredentialKind) {
  if (service === "jellyfin") return kind === "none";
  if (["seerr", "sabnzbd"].includes(service)) return kind === "none" || kind === "api_key";
  if (service === "qbittorrent") return kind === "username_password";
  return kind === "api_key";
}

function validateConnectorPolicy(
  input: {
    baseUrl: string;
    credentials: ConnectorCredentialInput;
    insecureHttpApproved: boolean;
    service: ManagedConnectorService;
    tlsCaCertificatePem?: string | undefined;
    tlsPolicy: ConnectorTlsPolicy;
  },
  context: z.core.$RefinementCtx,
) {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return;
  }
  if (url.protocol === "http:" && !input.insecureHttpApproved) {
    context.addIssue({
      code: "custom",
      path: ["insecureHttpApproved"],
      message: "Plain HTTP requires explicit administrator approval.",
    });
  }
  if (url.protocol === "https:" && input.insecureHttpApproved) {
    context.addIssue({
      code: "custom",
      path: ["insecureHttpApproved"],
      message: "Plain HTTP approval is valid only for an HTTP destination.",
    });
  }
  if (url.protocol !== "https:" && input.tlsPolicy !== "strict") {
    context.addIssue({
      code: "custom",
      path: ["tlsPolicy"],
      message: "A relaxed TLS policy is valid only for an HTTPS destination.",
    });
  }
  if (input.tlsPolicy === "allow_self_signed" && input.tlsCaCertificatePem === undefined) {
    context.addIssue({
      code: "custom",
      path: ["tlsCaCertificatePem"],
      message: "Self-signed TLS requires the connector's trusted CA certificate.",
    });
  }
  if (input.tlsPolicy === "strict" && input.tlsCaCertificatePem !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["tlsCaCertificatePem"],
      message: "A connector CA certificate is valid only with self-signed TLS approval.",
    });
  }
  if (!credentialKindAllowed(input.service, input.credentials.kind)) {
    context.addIssue({
      code: "custom",
      path: ["credentials", "kind"],
      message: "The credential kind is not valid for this connector service.",
    });
  }
}

export const connectorCreateRequestSchema = z
  .strictObject({
    id: connectorIdentifierSchema,
    service: managedConnectorServiceSchema,
    displayName: z.string().trim().min(1).max(160),
    baseUrl: connectorBaseUrlSchema,
    credentials: connectorCredentialInputSchema,
    tlsPolicy: connectorTlsPolicySchema.default("strict"),
    tlsCaCertificatePem: connectorTlsCaCertificatePemSchema.optional(),
    insecureHttpApproved: z.boolean().default(false),
  })
  .superRefine(validateConnectorPolicy);
export type ConnectorCreateRequest = z.infer<typeof connectorCreateRequestSchema>;

export const connectorUpdateRequestSchema = z
  .strictObject({
    revision: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    displayName: z.string().trim().min(1).max(160).optional(),
    baseUrl: connectorBaseUrlSchema.optional(),
    credentials: connectorCredentialInputSchema.optional(),
    tlsPolicy: connectorTlsPolicySchema.optional(),
    tlsCaCertificatePem: connectorTlsCaCertificatePemSchema.optional(),
    insecureHttpApproved: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.baseUrl !== undefined ||
      value.credentials !== undefined ||
      value.tlsPolicy !== undefined ||
      value.tlsCaCertificatePem !== undefined ||
      value.insecureHttpApproved !== undefined ||
      value.enabled !== undefined,
    { message: "A connector update must change at least one field." },
  );
export type ConnectorUpdateRequest = z.infer<typeof connectorUpdateRequestSchema>;

export const connectorAdminSchema = z.strictObject({
  id: connectorIdentifierSchema,
  service: managedConnectorServiceSchema,
  displayName: z.string().trim().min(1).max(160),
  baseUrl: connectorBaseUrlSchema,
  credentialKind: connectorCredentialKindSchema,
  credentialsConfigured: z.boolean(),
  tlsPolicy: connectorTlsPolicySchema,
  tlsCaCertificateConfigured: z.boolean(),
  insecureHttpApproved: z.boolean(),
  enabled: z.boolean(),
  healthState: z.enum(["unknown", "healthy", "degraded", "offline"]),
  lastProbe: connectorHealthSchema.nullable(),
  revision: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ConnectorAdmin = z.infer<typeof connectorAdminSchema>;

export const connectorAdminParamsSchema = z.strictObject({
  connectorId: connectorIdentifierSchema,
});
export type ConnectorAdminParams = z.infer<typeof connectorAdminParamsSchema>;

export const connectorListQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type ConnectorListQuery = z.infer<typeof connectorListQuerySchema>;

export const connectorListResponseSchema = z.strictObject({
  items: z.array(connectorAdminSchema).max(50),
  nextCursor: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .nullable(),
});
export type ConnectorListResponse = z.infer<typeof connectorListResponseSchema>;

export const connectorMutationResponseSchema = z.strictObject({ connector: connectorAdminSchema });
export type ConnectorMutationResponse = z.infer<typeof connectorMutationResponseSchema>;

export const connectorDeleteResponseSchema = z.strictObject({
  deletedConnectorId: connectorIdentifierSchema,
});
export type ConnectorDeleteResponse = z.infer<typeof connectorDeleteResponseSchema>;

export const connectorDeleteQuerySchema = z.strictObject({
  revision: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
});
export type ConnectorDeleteQuery = z.infer<typeof connectorDeleteQuerySchema>;

function withoutSchemaDialect<T extends z.ZodType>(schema: T) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;
  return jsonSchema;
}

export const connectorAdminJsonSchema = withoutSchemaDialect(connectorAdminSchema);
export const connectorAdminParamsJsonSchema = withoutSchemaDialect(connectorAdminParamsSchema);
export const connectorCreateRequestJsonSchema = withoutSchemaDialect(connectorCreateRequestSchema);
export const connectorDeleteQueryJsonSchema = withoutSchemaDialect(connectorDeleteQuerySchema);
export const connectorDeleteResponseJsonSchema = withoutSchemaDialect(
  connectorDeleteResponseSchema,
);
export const connectorListQueryJsonSchema = withoutSchemaDialect(connectorListQuerySchema);
export const connectorListResponseJsonSchema = withoutSchemaDialect(connectorListResponseSchema);
export const connectorMutationResponseJsonSchema = withoutSchemaDialect(
  connectorMutationResponseSchema,
);
export const connectorUpdateRequestJsonSchema = withoutSchemaDialect(connectorUpdateRequestSchema);
