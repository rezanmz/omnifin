const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_VALUE_PATTERN = /^[A-Za-z0-9 ._-]{1,80}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,4096}$/;

export interface JellyfinClientMetadata {
  appName?: string;
  appVersion?: string;
  deviceName?: string;
}

export interface JellyfinAuthorizationInput {
  accessToken?: string;
  deviceId: string;
  metadata?: JellyfinClientMetadata;
}

function boundedProtocolValue(value: string, name: string) {
  if (!CLIENT_VALUE_PATTERN.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

export function jellyfinClientMetadata(
  metadata: JellyfinClientMetadata = {},
): Required<JellyfinClientMetadata> {
  return Object.freeze({
    appName: boundedProtocolValue(metadata.appName ?? "Omnifin", "Jellyfin client name"),
    appVersion: boundedProtocolValue(metadata.appVersion ?? "0.0.0", "Jellyfin client version"),
    deviceName: boundedProtocolValue(
      metadata.deviceName ?? "Omnifin Gateway",
      "Jellyfin device name",
    ),
  });
}

export function jellyfinAuthorization(input: JellyfinAuthorizationInput) {
  if (!DEVICE_ID_PATTERN.test(input.deviceId)) {
    throw new TypeError("Jellyfin device identifier is invalid.");
  }
  if (input.accessToken !== undefined && !ACCESS_TOKEN_PATTERN.test(input.accessToken)) {
    throw new TypeError("Jellyfin access token is invalid.");
  }

  const metadata = jellyfinClientMetadata(input.metadata);
  const values = [
    `MediaBrowser Client="${metadata.appName}"`,
    `Device="${metadata.deviceName}"`,
    `DeviceId="${input.deviceId}"`,
    `Version="${metadata.appVersion}"`,
  ];
  if (input.accessToken !== undefined) values.push(`Token="${input.accessToken}"`);
  return values.join(", ");
}
