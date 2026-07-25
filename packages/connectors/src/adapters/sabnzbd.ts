import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { OptionalApiKeyConnectorConfig } from "../types.js";

const sabnzbdVersionSchema = z.object({
  version: upstreamVersionSchema,
});

export class SabnzbdAdapter extends ProbeOnlyAdapter {
  readonly service = "sabnzbd" as const;
  readonly #apiKey: string | null;

  constructor(config: OptionalApiKeyConnectorConfig) {
    const apiKey = config.apiKey?.trim() || null;
    super(config, apiKey ? [apiKey] : []);
    this.#apiKey = apiKey;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const version = await this.client.requestJson("api", sabnzbdVersionSchema, {
        operation: "probe",
        query: {
          mode: "version",
          output: "json",
          ...(this.#apiKey ? { apikey: this.#apiKey } : {}),
        },
        ...(signal ? { signal } : {}),
      });
      return version.version;
    });
  }
}
