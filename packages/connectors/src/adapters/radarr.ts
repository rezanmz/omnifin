import { ServarrAcquisitionAdapter } from "./servarr-acquisition.js";
import type { ApiKeyConnectorConfig } from "../types.js";

export class RadarrAdapter extends ServarrAcquisitionAdapter {
  readonly service = "radarr" as const;
  protected readonly apiPath = "api/v3/system/status";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }
}
