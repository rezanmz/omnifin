import type { ConnectorHealth, ConnectorService } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { ApiKeyConnectorConfig } from "../types.js";

const servarrStatusSchema = z.object({
  version: upstreamVersionSchema,
  appName: z.string().optional(),
  instanceName: z.string().optional(),
});

export abstract class ServarrAdapter extends ProbeOnlyAdapter {
  abstract override readonly service: Extract<ConnectorService, "radarr" | "sonarr" | "prowlarr">;
  protected abstract readonly apiPath: string;
  readonly #apiKey: string;

  protected constructor(config: ApiKeyConnectorConfig) {
    super(config, [config.apiKey]);
    this.#apiKey = config.apiKey;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const status = await this.client.requestJson(this.apiPath, servarrStatusSchema, {
        operation: "probe",
        headers: { "X-Api-Key": this.#apiKey },
        ...(signal ? { signal } : {}),
      });
      return status.version;
    });
  }
}
