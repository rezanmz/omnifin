import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  acquirePinnedDockerImage,
  classifyDockerImagePullFailure,
  DockerImagePullError,
  DOCKER_IMAGE_PULL_ATTEMPTS,
  DOCKER_IMAGE_PULL_RETRY_DELAYS_MS,
  DOCKER_LOCAL_IMAGE_ARGUMENTS,
} from "../integration/docker-runtime.mjs";

const PINNED_IMAGE = `ghcr.io/linuxserver/radarr:fixture@sha256:${"a".repeat(64)}`;

function execution({ error, status = 1, stderr = "", stdout = "" } = {}) {
  return { error, status, stderr, stdout };
}

test("keeps immutable image acquisition bounded and container launch local-only", () => {
  assert.equal(DOCKER_IMAGE_PULL_ATTEMPTS, 3);
  assert.deepEqual(DOCKER_IMAGE_PULL_RETRY_DELAYS_MS, [5_000, 15_000]);
  assert.deepEqual(DOCKER_LOCAL_IMAGE_ARGUMENTS, ["--pull", "never"]);
});

test("all disposable fixture families acquire before creating an isolated network", () => {
  for (const fixture of ["download-clients.mjs", "seerr-service.mjs", "servarr-services.mjs"]) {
    const source = readFileSync(new URL(`../integration/${fixture}`, import.meta.url), "utf8");
    const acquisition = source.indexOf("await acquirePinnedDockerImage(");
    const networkCreation = source.indexOf('["network", "create"', acquisition);

    assert.notEqual(acquisition, -1);
    assert.ok(networkCreation > acquisition);
    assert.match(source, /\.\.\.DOCKER_LOCAL_IMAGE_ARGUMENTS/u);
  }
});

test("acquires one digest-pinned image without retrying a successful pull", async () => {
  const calls = [];
  const result = await acquirePinnedDockerImage(PINNED_IMAGE, {
    execute(arguments_, timeout) {
      calls.push({ arguments_, timeout });
      return execution({ status: 0 });
    },
    wait() {
      assert.fail("a successful pull must not wait");
    },
  });

  assert.deepEqual(result, { attempts: 1 });
  assert.deepEqual(calls, [{ arguments_: ["pull", "--quiet", PINNED_IMAGE], timeout: 120_000 }]);
});

test("retries only classified transient image acquisition failures", async () => {
  const results = [
    execution({ stderr: "request failed: status code 503" }),
    execution({ error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }),
    execution({ status: 0 }),
  ];
  const waits = [];
  const result = await acquirePinnedDockerImage(PINNED_IMAGE, {
    execute() {
      return results.shift();
    },
    wait(milliseconds) {
      waits.push(milliseconds);
    },
  });

  assert.deepEqual(result, { attempts: 3 });
  assert.deepEqual(waits, [5_000, 15_000]);
  assert.equal(results.length, 0);
});

test("fails closed without retrying permanent registry responses", async () => {
  let calls = 0;
  const privateDiagnostic =
    "unauthorized: password=private /home/runner/private registry response status code 503";

  await assert.rejects(
    acquirePinnedDockerImage(PINNED_IMAGE, {
      execute() {
        calls += 1;
        return execution({ stderr: privateDiagnostic });
      },
      wait() {
        assert.fail("permanent failures must not wait");
      },
    }),
    (error) => {
      assert.ok(error instanceof DockerImagePullError);
      assert.equal(error.code, "image_pull_failed");
      assert.equal(error.message, "image_pull_failed");
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );

  assert.equal(calls, 1);
});

test("reports a bounded code after exhausting transient pulls", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    acquirePinnedDockerImage(PINNED_IMAGE, {
      execute() {
        calls += 1;
        return execution({ stderr: "temporary failure in name resolution" });
      },
      wait(milliseconds) {
        waits.push(milliseconds);
      },
    }),
    (error) => {
      assert.ok(error instanceof DockerImagePullError);
      assert.equal(error.code, "image_pull_transient_exhausted");
      return true;
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(waits, [5_000, 15_000]);
});

test("rejects mutable image references and invalid retry policies before execution", async () => {
  const execute = () => assert.fail("invalid policy must not execute Docker");
  await assert.rejects(
    acquirePinnedDockerImage("ghcr.io/linuxserver/radarr:latest", { execute }),
    /image_reference_invalid/u,
  );
  await assert.rejects(
    acquirePinnedDockerImage(PINNED_IMAGE, { attempts: 4, execute }),
    /image_pull_policy_invalid/u,
  );
  await assert.rejects(
    acquirePinnedDockerImage(PINNED_IMAGE, {
      attempts: 2,
      execute,
      retryDelaysMs: [],
    }),
    /image_pull_policy_invalid/u,
  );
  await assert.rejects(
    acquirePinnedDockerImage(PINNED_IMAGE, {
      attempts: 2,
      execute,
      retryDelaysMs: [-1],
    }),
    /image_pull_policy_invalid/u,
  );
});

test("classifies only explicit transient evidence as retryable", () => {
  assert.equal(
    classifyDockerImagePullFailure(execution({ stderr: "TLS handshake timeout" })),
    "transient",
  );
  assert.equal(
    classifyDockerImagePullFailure(execution({ stderr: "manifest unknown" })),
    "permanent",
  );
  assert.equal(
    classifyDockerImagePullFailure(execution({ stderr: "unknown daemon failure" })),
    "permanent",
  );
});
