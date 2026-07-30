#!/usr/bin/env node

import process from "node:process";

const MAX_INPUT_BYTES = 2 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const ALLOWED_METHODS = new Set(["GET", "POST"]);

function fail() {
  process.stderr.write('{"code":"container_transport_invalid","status":"failed"}\n');
  process.exitCode = 1;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error("input_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validatePayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.path !== "string" ||
    !/^\/api\/v1\/[A-Za-z0-9?&=/_-]{1,500}$/u.test(payload.path) ||
    typeof payload.method !== "string" ||
    !ALLOWED_METHODS.has(payload.method) ||
    !Array.isArray(payload.headers) ||
    payload.headers.length > 32 ||
    (payload.body !== null && typeof payload.body !== "string")
  ) {
    throw new Error("payload_invalid");
  }
  for (const entry of payload.headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      /[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(entry[0]) ||
      /[\r\n\0]/u.test(entry[1])
    ) {
      throw new Error("headers_invalid");
    }
  }
  if (payload.body !== null && Buffer.byteLength(payload.body, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("body_too_large");
  }
  return payload;
}

try {
  const payload = validatePayload(await readInput());
  const response = await fetch(new URL(payload.path, "http://127.0.0.1:5055/"), {
    body: payload.body ?? undefined,
    headers: new Headers(payload.headers),
    method: payload.method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  process.stdout.write(
    JSON.stringify({
      body: Buffer.from(bytes).toString("base64"),
      headers: [...response.headers.entries()],
      status: response.status,
    }),
  );
} catch {
  fail();
}
