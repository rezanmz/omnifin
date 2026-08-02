import {
  runtimeIdentityJsonSchema,
  runtimeIdentitySchema,
  type RuntimeIdentity,
} from "@omnifin/contracts/runtime";
import type { FastifyPluginAsync } from "fastify";

export interface RuntimeIdentityRoutesOptions {
  identity: RuntimeIdentity;
}

export const runtimeIdentityRoutes: FastifyPluginAsync<RuntimeIdentityRoutesOptions> = async (
  app,
  options,
) => {
  const identity = Object.freeze(runtimeIdentitySchema.parse(options.identity));

  app.get(
    "/v1/runtime",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { response: { 200: runtimeIdentityJsonSchema } },
    },
    async (_request, reply) => {
      reply.header("cache-control", "public, max-age=3600, stale-if-error=86400");
      reply.header("vary", "Accept-Encoding");
      return identity;
    },
  );
};
