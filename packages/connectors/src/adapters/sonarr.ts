import { ServarrAdapter } from "./servarr.js";
import type { ApiKeyConnectorConfig } from "../types.js";

export class SonarrAdapter extends ServarrAdapter {
  readonly service = "sonarr" as const;
  protected readonly apiPath = "api/v3/system/status";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }
}
