import { describe, expect, it } from "vitest";

import {
  INVITATION_DEFAULT_TTL_SECONDS,
  INVITATION_MAX_TTL_SECONDS,
  INVITATION_MIN_TTL_SECONDS,
  invitationCreateResponseSchema,
  invitationExchangeRequestSchema,
  invitationCreateRequestSchema,
  invitationSummarySchema,
} from "../src/invitations.js";

describe("invitation contracts", () => {
  it("keeps the default lifetime bounded at seven days", () => {
    expect(INVITATION_DEFAULT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(INVITATION_MIN_TTL_SECONDS).toBe(60 * 60);
    expect(INVITATION_MAX_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(invitationCreateRequestSchema.parse({})).toEqual({});
    expect(
      invitationCreateRequestSchema.parse({ expiresInSeconds: INVITATION_MIN_TTL_SECONDS }),
    ).toEqual({
      expiresInSeconds: INVITATION_MIN_TTL_SECONDS,
    });
    expect(
      invitationCreateRequestSchema.parse({ expiresInSeconds: INVITATION_MAX_TTL_SECONDS }),
    ).toEqual({
      expiresInSeconds: INVITATION_MAX_TTL_SECONDS,
    });
    expect(() =>
      invitationCreateRequestSchema.parse({ expiresInSeconds: INVITATION_MIN_TTL_SECONDS - 1 }),
    ).toThrow();
    expect(() =>
      invitationCreateRequestSchema.parse({ expiresInSeconds: INVITATION_MAX_TTL_SECONDS + 1 }),
    ).toThrow();
    expect(() => invitationCreateRequestSchema.parse({ expiresInMs: 60 * 60 * 1_000 })).toThrow();
  });

  it("defines summaries without a secret-bearing field", () => {
    const summary = invitationSummarySchema.parse({
      consumedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-08T00:00:00.000Z",
      id: "invite_contract-test",
      revokedAt: null,
      status: "active",
    });
    expect(summary).not.toHaveProperty("token");
    expect(summary).not.toHaveProperty("tokenHash");
  });

  it("requires the public exchange body to be exactly one invite token", () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    expect(invitationExchangeRequestSchema.parse({ token })).toEqual({ token });
    expect(() => invitationExchangeRequestSchema.parse({ token, extra: true })).toThrow();
    expect(() => invitationExchangeRequestSchema.parse({ token: "not-a-token" })).toThrow();
  });

  it("requires admin invitation URLs to land on the invite route", () => {
    const token = Buffer.alloc(32, 8).toString("base64url");
    const response = invitationCreateResponseSchema.parse({
      invitation: {
        consumedAt: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-08T00:00:00.000Z",
        id: "invite_contract-url",
        revokedAt: null,
        status: "active",
      },
      invitationUrl: `https://omnifin.example/invite#invite=${token}`,
    });
    expect(response.invitationUrl).toContain("/invite#invite=");
    expect(() =>
      invitationCreateResponseSchema.parse({
        ...response,
        invitationUrl: `https://omnifin.example/#invite=${token}`,
      }),
    ).toThrow();
  });
});
