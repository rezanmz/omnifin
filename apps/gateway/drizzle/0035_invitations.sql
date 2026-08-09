CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer,
	`registration_handoff_hash` text,
	`registration_handoff_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "invitations_id_check" CHECK(length("invitations"."id") between 8 and 128
        and substr("invitations"."id", 1, 7) = 'invite_'
        and substr("invitations"."id", 8) not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "invitations_token_hash_check" CHECK(length("invitations"."token_hash") = 43 and "invitations"."token_hash" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "invitations_registration_handoff_hash_check" CHECK("invitations"."registration_handoff_hash" is null or (
        length("invitations"."registration_handoff_hash") = 43
        and "invitations"."registration_handoff_hash" not glob '*[^A-Za-z0-9_-]*'
      )),
	CONSTRAINT "invitations_timestamp_check" CHECK("invitations"."created_at" >= 0
        and "invitations"."created_at" < "invitations"."expires_at"
        and ("invitations"."consumed_at" is null or ("invitations"."consumed_at" >= "invitations"."created_at" and "invitations"."consumed_at" < "invitations"."expires_at"))
        and ("invitations"."revoked_at" is null or ("invitations"."revoked_at" >= "invitations"."created_at" and "invitations"."revoked_at" < "invitations"."expires_at"))
        and ("invitations"."consumed_at" is null or "invitations"."revoked_at" is null)
        and (("invitations"."registration_handoff_hash" is null and "invitations"."registration_handoff_expires_at" is null)
          or ("invitations"."registration_handoff_hash" is not null and "invitations"."registration_handoff_expires_at" is not null))
        and ("invitations"."consumed_at" is null and "invitations"."revoked_at" is null
          or "invitations"."registration_handoff_hash" is null and "invitations"."registration_handoff_expires_at" is null)
        and ("invitations"."registration_handoff_expires_at" is null
          or ("invitations"."registration_handoff_expires_at" >= "invitations"."created_at"
            and "invitations"."registration_handoff_expires_at" <= "invitations"."expires_at")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_registration_handoff_hash_unique` ON `invitations` (`registration_handoff_hash`) WHERE "invitations"."registration_handoff_hash" is not null;--> statement-breakpoint
CREATE INDEX `invitations_created_idx` ON `invitations` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `invitations_expiry_idx` ON `invitations` (`expires_at`);
