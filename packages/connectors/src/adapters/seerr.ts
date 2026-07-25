import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { OptionalApiKeyConnectorConfig } from "../types.js";

const seerrStatusSchema = z.object({
  version: upstreamVersionSchema,
  commitTag: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  commitsBehind: z.number().optional(),
  restartRequired: z.boolean().optional(),
});

export class SeerrAdapter extends ProbeOnlyAdapter {
  readonly service = "seerr" as const;
  readonly #apiKey: string | null;

  constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim() || null;
    super(config, apiKey ? [apiKey] : []);
    this.#apiKey = apiKey;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const status = await this.client.requestJson("api/v1/status", seerrStatusSchema, {
        operation: "probe",
        ...(this.#apiKey ? { headers: { "X-Api-Key": this.#apiKey } } : {}),
        ...(signal ? { signal } : {}),
      });
      return status.version;
    });
  }
}
