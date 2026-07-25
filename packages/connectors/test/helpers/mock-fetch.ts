import type { ResolvedHostAddress } from "../../src/security/destination.js";
import type {
  ConnectorClock,
  ConnectorTransport,
  ConnectorTransportInit,
} from "../../src/types.js";

export interface CapturedRequest {
  url: URL;
  init: ConnectorTransportInit;
  pinnedAddresses: readonly ResolvedHostAddress[];
}

export function createMockTransport(responses: readonly Response[]): {
  transport: ConnectorTransport;
  requests: CapturedRequest[];
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  const mock: ConnectorTransport = async (url, init, pinnedAddresses) => {
    requests.push({ url: new URL(url), init, pinnedAddresses });
    const response = queue.shift();
    if (!response) throw new Error("No mock response was configured for this request.");
    return response;
  };

  return { transport: mock, requests };
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export const publicResolver = async () => [{ address: "1.1.1.1", family: 4 as const }];

export function fixedClock(): ConnectorClock {
  const ticks = [100, 112];
  let tickIndex = 0;
  return {
    now: () => new Date("2026-07-25T12:00:00.000Z"),
    monotonicNow: () => ticks[tickIndex++] ?? 112,
  };
}
