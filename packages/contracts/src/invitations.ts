import { z } from "zod";

export const INVITATION_TOKEN_BYTES = 32;
export const REGISTRATION_HANDOFF_TOKEN_BYTES = 32;
export const REGISTRATION_HANDOFF_TTL_SECONDS = 15 * 60;
export const INVITATION_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITATION_MIN_TTL_SECONDS = 60 * 60;
export const INVITATION_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
export const INVITATIONS_PAGE_MAX_COUNT = 50;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

const dateTimeSchema = z.iso.datetime({ offset: true });
const invitationTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const invitationStatusSchema = z.enum(["active", "expired", "consumed", "revoked"]);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationCreateRequestSchema = z.strictObject({
  expiresInSeconds: z
    .int()
    .min(INVITATION_MIN_TTL_SECONDS)
    .max(INVITATION_MAX_TTL_SECONDS)
    .optional(),
});
export type InvitationCreateRequest = z.infer<typeof invitationCreateRequestSchema>;

export const invitationSummarySchema = z.strictObject({
  consumedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  id: identifierSchema,
  revokedAt: dateTimeSchema.nullable(),
  status: invitationStatusSchema,
});
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;

export const invitationCreateResponseSchema = z.strictObject({
  invitation: invitationSummarySchema,
  invitationUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.pathname === "/invite" &&
      url.search === "" &&
      /^#invite=[A-Za-z0-9_-]{43}$/u.test(url.hash)
    );
  }, "Invitation URLs must carry the token in the fragment."),
});
export type InvitationCreateResponse = z.infer<typeof invitationCreateResponseSchema>;

export const invitationExchangeRequestSchema = z.strictObject({
  token: invitationTokenSchema,
});
export type InvitationExchangeRequest = z.infer<typeof invitationExchangeRequestSchema>;

export const invitationListQuerySchema = z.strictObject({
  cursor: identifierSchema.optional(),
});
export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>;

export const invitationListResponseSchema = z.strictObject({
  invitations: z.array(invitationSummarySchema).max(INVITATIONS_PAGE_MAX_COUNT),
  nextCursor: identifierSchema.nullable(),
});
export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>;

export const invitationAdminParamsSchema = z.strictObject({
  invitationId: identifierSchema,
});
export type InvitationAdminParams = z.infer<typeof invitationAdminParamsSchema>;

export const invitationRevokeResponseSchema = z.strictObject({
  invitation: invitationSummarySchema,
});
export type InvitationRevokeResponse = z.infer<typeof invitationRevokeResponseSchema>;
