import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateReference,
  isExplicitThrottleDiagnostic,
  publishOciCandidate,
  retryDelay,
} from "./publish-oci-candidate.mjs";

const headSha = "a".repeat(40);
const buildDigest = `sha256:${"b".repeat(64)}`;
const otherDigest = `sha256:${"c".repeat(64)}`;
const candidateTag = `edge-candidate-${headSha}-31393922588`;
const imageName = "ghcr.io/rezanmz/omnifin";
const archive = "/tmp/edge-artifacts/candidate.oci.tar";
const reference = `${imageName}:${candidateTag}`;
const resolved = (digest = buildDigest) => ({ status: 0, stdout: `${digest}\n`, stderr: "" });
const failed = (stderr, status = 1) => ({ status, stdout: "", stderr });

function recorder(results) {
  const calls = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("binds publication to the immutable edge candidate reference", () => {
  assert.equal(candidateReference(imageName, candidateTag), reference);
  assert.throws(() => candidateReference(imageName, "edge"), /immutable edge run/u);
  assert.throws(() => candidateReference("ghcr.io/Example/omnifin", candidateTag), /lowercase/u);
});

test("recognizes only explicit throttling evidence", () => {
  assert.equal(isExplicitThrottleDiagnostic("HTTP 403: secondary rate limit"), true);
  assert.equal(isExplicitThrottleDiagnostic("429 Too Many Requests"), true);
  assert.equal(isExplicitThrottleDiagnostic("403 permission_denied Forbidden"), false);
  assert.equal(isExplicitThrottleDiagnostic("network unavailable"), false);
});

test("retries an actual secondary-rate-limit 403 and preserves every publication input", async () => {
  const delays = [];
  const events = recorder([
    failed("HTTP 403 Forbidden: You have exceeded a secondary rate limit."),
    failed("HTTP 403 Forbidden: You have exceeded a secondary rate limit."),
    failed("manifest unknown"),
    resolved(),
    resolved(),
  ]);

  const result = await publishOciCandidate(
    { archive, buildDigest, candidateTag, imageName },
    {
      random: () => 0,
      run: events.run,
      sleep: async (delay) => delays.push(delay),
      write: () => {},
    },
  );

  assert.equal(result, buildDigest);
  assert.deepEqual(delays, [60_000, 120_000]);
  assert.deepEqual(events.calls, [
    ["resolve", reference],
    ["resolve", reference],
    ["resolve", reference],
    ["cp", "--from-oci-layout", `${archive}:${candidateTag}`, reference],
    ["resolve", reference],
  ]);
});

test("does not retry generic authorization failures", async () => {
  const events = recorder([failed("HTTP 403 permission_denied Forbidden")]);
  const sleeps = [];

  await assert.rejects(
    publishOciCandidate(
      { archive, buildDigest, candidateTag, imageName },
      { run: events.run, sleep: async (delay) => sleeps.push(delay), write: () => {} },
    ),
    /ORAS resolve failed/u,
  );
  assert.equal(events.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("retries an explicit HTTP 429", async () => {
  const events = recorder([failed("unexpected status: HTTP 429"), resolved()]);
  const sleeps = [];

  const result = await publishOciCandidate(
    { archive, buildDigest, candidateTag, imageName },
    {
      attempts: 2,
      random: () => 1,
      run: events.run,
      sleep: async (delay) => sleeps.push(delay),
      write: () => {},
    },
  );

  assert.equal(result, buildDigest);
  assert.deepEqual(sleeps, [90_000]);
  assert.deepEqual(events.calls, [
    ["resolve", reference],
    ["resolve", reference],
  ]);
});

test("exhausts at three attempts with bounded jittered delays", async () => {
  const events = recorder([
    failed("HTTP 429 Too Many Requests"),
    failed("HTTP 429 Too Many Requests"),
    failed("HTTP 429 Too Many Requests"),
  ]);
  const delays = [];

  await assert.rejects(
    publishOciCandidate(
      { archive, buildDigest, candidateTag, imageName },
      {
        random: () => 0.5,
        run: events.run,
        sleep: async (delay) => delays.push(delay),
        write: () => {},
      },
    ),
    /failed after 3 attempts/u,
  );
  assert.deepEqual(delays, [75_000, 135_000]);
  assert.ok(delays[0] >= 60_000 && delays[0] <= 90_000);
  assert.ok(delays[1] >= 120_000 && delays[1] <= 150_000);
  assert.equal(events.calls.length, 3);
  assert.equal(
    retryDelay(1, () => 0),
    60_000,
  );
  assert.equal(
    retryDelay(2, () => 1),
    150_000,
  );
});

test("returns an existing matching digest without copying", async () => {
  const events = recorder([resolved()]);
  const result = await publishOciCandidate(
    { archive, buildDigest, candidateTag, imageName },
    { run: events.run },
  );

  assert.equal(result, buildDigest);
  assert.deepEqual(events.calls, [["resolve", reference]]);
});

test("rejects a different existing digest without mutation", async () => {
  const events = recorder([resolved(otherDigest)]);

  await assert.rejects(
    publishOciCandidate({ archive, buildDigest, candidateTag, imageName }, { run: events.run }),
    /different digest/u,
  );
  assert.deepEqual(events.calls, [["resolve", reference]]);
});

test("resolves a partial copy on the next attempt and never changes its source", async () => {
  const events = recorder([
    failed("manifest unknown"),
    failed("HTTP 429 Too Many Requests"),
    resolved(),
  ]);
  const sleeps = [];

  const result = await publishOciCandidate(
    { archive, buildDigest, candidateTag, imageName },
    {
      attempts: 2,
      random: () => 0,
      run: events.run,
      sleep: async (delay) => sleeps.push(delay),
      write: () => {},
    },
  );

  assert.equal(result, buildDigest);
  assert.deepEqual(sleeps, [60_000]);
  assert.deepEqual(events.calls, [
    ["resolve", reference],
    ["cp", "--from-oci-layout", `${archive}:${candidateTag}`, reference],
    ["resolve", reference],
  ]);
});

test("fails closed when the post-copy remote digest does not match", async () => {
  const events = recorder([failed("manifest unknown"), { status: 0 }, resolved(otherDigest)]);

  await assert.rejects(
    publishOciCandidate({ archive, buildDigest, candidateTag, imageName }, { run: events.run }),
    /differs from the built OCI archive/u,
  );
  assert.deepEqual(events.calls, [
    ["resolve", reference],
    ["cp", "--from-oci-layout", `${archive}:${candidateTag}`, reference],
    ["resolve", reference],
  ]);
});
