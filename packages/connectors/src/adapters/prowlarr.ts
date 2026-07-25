import { ServarrAdapter } from "./servarr.js";
import type { ApiKeyConnectorConfig } from "../types.js";

export class ProwlarrAdapter extends ServarrAdapter {
  readonly service = "prowlarr" as const;
  protected readonly apiPath = "api/v1/system/status";

  constructor(config: ApiKeyConnectorConfig) {
    super(config);
  }
}
