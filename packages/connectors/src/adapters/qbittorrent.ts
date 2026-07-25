import type { ConnectorHealth } from "@omnifin/contracts/connectors";

import { ProbeOnlyAdapter } from "./base.js";
import { SafeConnectorError } from "../http/safe-http-client.js";
import type { ConnectorTargetConfig } from "../types.js";

export interface QBittorrentAdapterConfig extends ConnectorTargetConfig {
  username: string;
  password: string;
}

function readSessionCookie(setCookie: string | null): string | null {
  const sessionId = setCookie?.match(/(?:^|;\s*)SID=([^;]+)/i)?.[1];
  return sessionId && /^[A-Za-z0-9._~-]{1,512}$/.test(sessionId) ? `SID=${sessionId}` : null;
}

export class QBittorrentAdapter extends ProbeOnlyAdapter {
  readonly service = "qbittorrent" as const;
  readonly #username: string;
  readonly #password: string;

  constructor(config: QBittorrentAdapterConfig) {
    super(config, [config.username, config.password]);
    this.#username = config.username;
    this.#password = config.password;
  }

  probe(signal?: AbortSignal): Promise<ConnectorHealth> {
    return this.runProbe("probe", async () => {
      const form = new URLSearchParams({ username: this.#username, password: this.#password });
      const login = await this.client.requestText("api/v2/auth/login", {
        operation: "authenticate",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Origin: this.client.origin,
          Referer: `${this.client.origin}/`,
        },
        body: form,
        ...(signal ? { signal } : {}),
      });

      const cookie = readSessionCookie(login.headers.get("set-cookie"));
      if (login.body.trim() !== "Ok." || !cookie) {
        throw new SafeConnectorError({
          service: this.service,
          operation: "authenticate",
          code: "invalid_credentials",
          message: "qbittorrent rejected the configured credentials.",
          retryable: false,
        });
      }

      const version = await this.client.requestText("api/v2/app/version", {
        operation: "probe",
        headers: { Cookie: cookie },
        ...(signal ? { signal } : {}),
      });
      return {
        value: version.body,
        additionalProtectedValues: [cookie.slice("SID=".length)],
      };
    });
  }
}
