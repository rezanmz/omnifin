import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: process.env.OMNIFIN_DATABASE_URL ?? "./data/omnifin.db",
  },
  strict: true,
  verbose: true,
});
