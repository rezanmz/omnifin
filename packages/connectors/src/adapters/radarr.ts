import { ServarrAdapter } from "./servarr.js";
import type { ApiKeyConnectorConfig } from "../types.js";

export class RadarrAdapter extends ServarrAdapter {
  readonly service = "radarr" as const;
  protected readonly apiPath = "api/v3/system/status";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }
}
