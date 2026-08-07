import {
  appearanceUpdateResponseSchema,
  themePreferenceSchema,
  type SessionPrincipal,
} from "@omnifin/contracts/auth";
import type { DatabaseHandle } from "../db/client.js";

import { requirePermission } from "./authorization.js";

export type AppearanceErrorReason = "not_found" | "unavailable";

export class AppearanceError extends Error {
  public readonly code = "appearance_unavailable";
  public readonly reason: AppearanceErrorReason;

  public constructor(reason: AppearanceErrorReason, options?: ErrorOptions) {
    super(
      reason === "not_found"
        ? "This account is no longer available."
        : "The appearance preference is temporarily unavailable.",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AppearanceError";
    this.reason = reason;
  }
}

interface UserThemeRow {
  themePreference: string | null;
}

export interface AppearanceContext {
  principal: SessionPrincipal;
}

export class AppearanceService {
  readonly #database: DatabaseHandle;

  public constructor(database: DatabaseHandle) {
    this.#database = database;
  }

  public read(context: AppearanceContext) {
    const principal = requirePermission(context.principal, "identities.self.manage");
    if (principal.userId === null) throw new AppearanceError("not_found");
    const row = this.#database.sqlite
      .prepare(
        `select theme_preference as themePreference
           from users
          where id = ?
          limit 1`,
      )
      .get(principal.userId) as UserThemeRow | undefined;
    if (!row) throw new AppearanceError("not_found");
    try {
      return appearanceUpdateResponseSchema.parse({
        theme: themePreferenceSchema.parse(row.themePreference ?? "system"),
      });
    } catch (error) {
      throw new AppearanceError("unavailable", { cause: error });
    }
  }

  public update(context: AppearanceContext, rawRequest: { theme: string }) {
    const principal = requirePermission(context.principal, "identities.self.manage");
    if (principal.userId === null) throw new AppearanceError("not_found");
    const theme = themePreferenceSchema.parse(rawRequest.theme);
    const updated = this.#database.sqlite
      .prepare(
        `update users
            set theme_preference = ?, updated_at = unixepoch('subsec') * 1000
          where id = ?`,
      )
      .run(theme, principal.userId);
    if (updated.changes !== 1) throw new AppearanceError("not_found");
    return appearanceUpdateResponseSchema.parse({ theme });
  }
}
