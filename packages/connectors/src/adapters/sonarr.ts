import { ServarrAcquisitionAdapter } from "./servarr-acquisition.js";
import type { ApiKeyConnectorConfig } from "../types.js";

export class SonarrAdapter extends ServarrAcquisitionAdapter {
  readonly service = "sonarr" as const;
  protected readonly apiPath = "api/v3/system/status";
  protected readonly apiRoot = "api/v3";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }
}
