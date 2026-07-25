import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const bazarrStatusSchema = z.object({
  data: z.object({
    bazarr_version: upstreamVersionSchema,
  }),
});

export class BazarrAdapter extends ProbeOnlyAdapter {
  readonly service = "bazarr" as const;
  readonly #apiKey: string;

  constructor(config: ApiKeyConnectorConfig) {
    super(config, [config.apiKey]);
    this.#apiKey = config.apiKey;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const status = await this.client.requestJson("api/system/status", bazarrStatusSchema, {
        operation: "probe",
        headers: { "X-API-KEY": this.#apiKey },
        ...(signal ? { signal } : {}),
      });
      return status.data.bazarr_version;
    });
  }
}
