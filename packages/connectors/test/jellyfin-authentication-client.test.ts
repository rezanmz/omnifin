import { describe, expect, it } from "vitest";

import { JellyfinAuthenticationClient } from "../src/auth/jellyfin-authentication-client.js";
import { SafeConnectorError } from "../src/http/safe-http-client.js";
import { createMockTransport, jsonResponse, publicResolver } from "./helpers/mock-fetch.js";

const target = (transport: ReturnType<typeof createMockTransport>["transport"]) => ({
  baseUrl: "https://jellyfin.example.test/base/",
  connectorId: "jellyfin-home",
  displayName: "Home Jellyfin",
  resolveHost: publicResolver,
  transport,
});

describe("JellyfinAuthenticationClient", () => {
  it("retains bounded public server identity for internal binding", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "stable-server-id", ServerName: "Home", Version: "10.11.2" }),
    ]);
    const client = new JellyfinAuthenticationClient(target(mock.transport));

    await expect(client.getPublicSystemInfo()).resolves.toEqual({
      Id: "stable-server-id",
      ServerName: "Home",
      Version: "10.11.2",
    });
  });

  it("authenticates by name with the modern device header and bounded JSON body", async () => {
    const mock = createMockTransport([
      jsonResponse({
        AccessToken: "private-access-token",
        ServerId: "server-1",
        User: {
          Id: "user-1",
          Name: "Riley",
          Policy: { IsAdministrator: true },
        },
      }),
    ]);
    const client = new JellyfinAuthenticationClient(target(mock.transport), {
      appVersion: "1.2.3",
    });

    const result = await client.authenticateByName({
      deviceId: "installation-browser-1",
      password: "private-password",
      username: "riley",
    });

    expect(result).toEqual({
      AccessToken: "private-access-token",
      ServerId: "server-1",
      User: {
        Id: "user-1",
        Name: "Riley",
        Policy: { IsAdministrator: true },
      },
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.url.href).toBe(
      "https://jellyfin.example.test/base/Users/AuthenticateByName",
    );
    expect(mock.requests[0]?.init.method).toBe("POST");
    expect(mock.requests[0]?.init.headers.get("authorization")).toBe(
      'MediaBrowser Client="Omnifin", Device="Omnifin Gateway", DeviceId="installation-browser-1", Version="1.2.3"',
    );
    expect(new TextDecoder().decode(mock.requests[0]?.init.body)).toBe(
      JSON.stringify({ Pw: "private-password", Username: "riley" }),
    );
  });

  it("supports Quick Connect without returning a secret in request metadata", async () => {
    const quickConnect = {
      Authenticated: false,
      Code: "381942",
      DateAdded: "2026-07-26T12:00:00.000Z",
      Secret: "private-quick-connect-secret",
    };
    const mock = createMockTransport([
      jsonResponse(true),
      jsonResponse(quickConnect),
      jsonResponse({ ...quickConnect, Authenticated: true }),
      jsonResponse({
        AccessToken: "private-access-token",
        ServerId: "server-1",
        User: {
          Id: "user-1",
          Name: "Riley",
          Policy: { IsAdministrator: true },
        },
      }),
    ]);
    const client = new JellyfinAuthenticationClient(target(mock.transport));

    await expect(client.quickConnectEnabled({ deviceId: "device-1" })).resolves.toBe(true);
    await expect(client.initiateQuickConnect({ deviceId: "device-1" })).resolves.toEqual(
      quickConnect,
    );
    await expect(
      client.pollQuickConnect({ deviceId: "device-1", secret: quickConnect.Secret }),
    ).resolves.toMatchObject({ Authenticated: true });
    await expect(
      client.authenticateWithQuickConnect({
        deviceId: "device-1",
        secret: quickConnect.Secret,
      }),
    ).resolves.toMatchObject({ AccessToken: "private-access-token" });

    expect(mock.requests.map((request) => request.url.pathname)).toEqual([
      "/base/QuickConnect/Enabled",
      "/base/QuickConnect/Initiate",
      "/base/QuickConnect/Connect",
      "/base/Users/AuthenticateWithQuickConnect",
    ]);
    expect(mock.requests[2]?.url.searchParams.get("secret")).toBe(quickConnect.Secret);
    expect(new TextDecoder().decode(mock.requests[3]?.init.body)).toBe(
      JSON.stringify({ Secret: quickConnect.Secret }),
    );
  });

  it("fails closed when Jellyfin returns an invalid authentication result", async () => {
    const mock = createMockTransport([
      jsonResponse({
        AccessToken: "",
        ServerId: "server-1",
        User: { Id: "user-1", Name: "Riley" },
      }),
    ]);
    const client = new JellyfinAuthenticationClient(target(mock.transport));

    await expect(
      client.authenticateByName({
        deviceId: "device-1",
        password: "private-password",
        username: "riley",
      }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("rejects authentication results that omit the administrator policy proof", async () => {
    const mock = createMockTransport([
      jsonResponse({
        AccessToken: "private-access-token",
        ServerId: "server-1",
        User: { Id: "user-1", Name: "Riley" },
      }),
    ]);
    const client = new JellyfinAuthenticationClient(target(mock.transport));

    await expect(
      client.authenticateByName({
        deviceId: "device-1",
        password: "private-password",
        username: "riley",
      }),
    ).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("maps invalid credentials to a safe connector failure without echoing secrets", async () => {
    const mock = createMockTransport([new Response("private-password", { status: 401 })]);
    const client = new JellyfinAuthenticationClient(target(mock.transport));

    let failure: unknown;
    try {
      await client.authenticateByName({
        deviceId: "device-1",
        password: "private-password",
        username: "riley",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SafeConnectorError);
    expect(failure).toMatchObject({ code: "invalid_credentials", status: 401 });
    expect(JSON.stringify(failure)).not.toContain("private-password");
    expect(failure instanceof Error ? failure.message : "").not.toContain("private-password");
  });

  it("rejects unsafe device metadata before making a request", async () => {
    const mock = createMockTransport([]);
    const client = new JellyfinAuthenticationClient(target(mock.transport));

    expect(() =>
      client.authenticateByName({
        deviceId: 'device-1", Token="injected',
        password: "private-password",
        username: "riley",
      }),
    ).toThrow(/device identifier/i);
    expect(mock.requests).toHaveLength(0);
  });

  it("preserves connector-specific TLS policy for authentication requests", async () => {
    const mock = createMockTransport([
      jsonResponse({ Id: "server-1", ServerName: "Home", Version: "10.11.11" }),
    ]);
    const client = new JellyfinAuthenticationClient({
      ...target(mock.transport),
      tlsCaCertificatePem: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
      tlsPolicy: "allow_self_signed",
    });

    await client.getPublicSystemInfo();

    expect(mock.requests[0]?.init.tlsPolicy).toBe("allow_self_signed");
    expect(mock.requests[0]?.init.tlsCaCertificatePem).toContain("BEGIN CERTIFICATE");
  });
});
