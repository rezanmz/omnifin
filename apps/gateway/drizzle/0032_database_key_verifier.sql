CREATE TABLE `database_key_verifiers` (
	`id` integer PRIMARY KEY NOT NULL,
	`format_version` integer DEFAULT 1 NOT NULL,
	`verifier` text NOT NULL,
	CONSTRAINT "database_key_verifiers_singleton_check" CHECK("database_key_verifiers"."id" = 1),
	CONSTRAINT "database_key_verifiers_format_check" CHECK("database_key_verifiers"."format_version" = 1),
	CONSTRAINT "database_key_verifiers_value_check" CHECK(length("database_key_verifiers"."verifier") = 43 and "database_key_verifiers"."verifier" not glob '*[^A-Za-z0-9_-]*')
);
