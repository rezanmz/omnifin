import assert from "node:assert/strict";
import test from "node:test";

import { ociImageReference, signOciImage } from "./sign-oci-image.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const reference = `ghcr.io/rezanmz/omnifin@${digest}`;

test("binds signing to a lowercase GHCR repository and immutable digest", () => {
  assert.equal(ociImageReference("ghcr.io/rezanmz/omnifin", digest), reference);
  assert.throws(
    () => ociImageReference("docker.io/rezanmz/omnifin", digest),
    /lowercase GHCR repository/u,
  );
  assert.throws(
    () => ociImageReference("ghcr.io/rezanmz/omnifin", "latest"),
    /immutable sha256 digest/u,
  );
});

test("returns immediately after a successful signature", async () => {
  const events = [];

  await signOciImage(reference, {
    run: async () => {
      events.push("run");
      return 0;
    },
    sleep: async () => events.push("sleep"),
    write: (message) => events.push(message),
  });

  assert.deepEqual(events, ["run", "[oci-sign] attempt=1/3 result=success"]);
});

test("retries a transient registry failure with bounded backoff", async () => {
  const delays = [];
  let runs = 0;

  await signOciImage(reference, {
    run: async () => {
      runs += 1;
      return runs === 3 ? 0 : 1;
    },
    sleep: async (delay) => delays.push(delay),
    write: () => {},
  });

  assert.equal(runs, 3);
  assert.deepEqual(delays, [5_000, 15_000]);
});

test("fails closed after exhausting the retry budget", async () => {
  let runs = 0;

  await assert.rejects(
    signOciImage(reference, {
      attempts: 2,
      backoffMs: [0],
      run: async () => {
        runs += 1;
        throw new Error("registry unavailable");
      },
      sleep: async () => {},
      write: () => {},
    }),
    /failed after 2 bounded attempts/u,
  );
  assert.equal(runs, 2);
});
