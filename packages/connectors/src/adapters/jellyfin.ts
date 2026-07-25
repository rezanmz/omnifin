import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { ConnectorTargetConfig } from "../types.js";

const jellyfinPublicSystemInfoSchema = z.object({
  Version: upstreamVersionSchema,
  ProductName: z.string().trim().min(1).optional(),
});

export class JellyfinAdapter extends ProbeOnlyAdapter {
  readonly service = "jellyfin" as const;

  constructor(config: ConnectorTargetConfig) {
    super(config);
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const info = await this.client.requestJson(
        "System/Info/Public",
        jellyfinPublicSystemInfoSchema,
        { operation: "probe", ...(signal ? { signal } : {}) },
      );
      return info.Version;
    });
  }
}
