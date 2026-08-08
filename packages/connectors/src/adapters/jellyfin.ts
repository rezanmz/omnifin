import type { ConnectorHealth } from "@omnifin/contracts/connectors";
import { z } from "zod";

import { ProbeOnlyAdapter } from "./base.js";
import { upstreamVersionSchema } from "./schemas.js";
import type { ConnectorTargetConfig } from "../types.js";

const jellyfinPublicSystemInfoSchema = z.object({
  Id: z.string().trim().min(1).max(256),
  Version: upstreamVersionSchema,
  ProductName: z.string().trim().min(1).optional(),
});

export interface JellyfinProbeResult {
  readonly health: ConnectorHealth;
  /** Stable upstream identity for trusted internal binding. Never include this in public health. */
  readonly stableInstanceIdentity: string | null;
}

export class JellyfinAdapter extends ProbeOnlyAdapter {
  readonly service = "jellyfin" as const;

  constructor(config: ConnectorTargetConfig) {
    super(config);
  }

  async probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return (await this.probeWithIdentity(signal)).health;
  }

  async probeWithIdentity(signal?: AbortSignal): Promise<JellyfinProbeResult> {
    let stableInstanceIdentity: string | null = null;
    const health = await this.runProbe("probe", async () => {
      const info = await this.client.requestJson(
        "System/Info/Public",
        jellyfinPublicSystemInfoSchema,
        { operation: "probe", ...(signal ? { signal } : {}) },
      );
      stableInstanceIdentity = info.Id;
      return info.Version;
    });
    return Object.freeze({
      health,
      stableInstanceIdentity: health.status === "healthy" ? stableInstanceIdentity : null,
    });
  }
}
