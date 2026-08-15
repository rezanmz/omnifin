import assert from "node:assert/strict";
import test from "node:test";

import { validateHomeLabEvidence } from "./home-lab-evidence.mjs";

const sourceSha = "a".repeat(40);
const candidateDigest = `sha256:${"b".repeat(64)}`;

function report() {
  return {
    architecture: "linux/arm64",
    candidateDigest,
    deployment: {
      network: "real",
      tls: "reverse-proxy",
      type: "home-lab",
    },
    expiresAt: "2026-09-13",
    owner: "home-lab-operator",
    result: "passed",
    schemaVersion: 1,
    sourceSha,
    upstream: {
      versions: {
        jellyfin: "10.11.1",
      },
    },
    verifiedAt: "2026-08-14",
    verifiedCoverage: [
      "documented-install",
      "tls-reverse-proxy",
      "bootstrap",
      "backup",
      "empty-host-restore",
      "upgrade",
      "rollback",
      "troubleshooting",
      "real-network",
      "sse-media-proxying",
      "recovery-evidence",
      "sanitized-diagnostics",
    ],
  };
}

test("accepts an exact-candidate TLS home-lab rehearsal report", () => {
  assert.deepEqual(
    validateHomeLabEvidence(report(), { candidateDigest, sourceSha, today: "2026-08-14" }),
    report(),
  );
});

test("rejects a report bound to a different candidate digest", () => {
  assert.throws(
    () =>
      validateHomeLabEvidence(
        { ...report(), candidateDigest: `sha256:${"c".repeat(64)}` },
        { candidateDigest, sourceSha, today: "2026-08-14" },
      ),
    /candidateDigest must match/u,
  );
});

test("rejects expired home-lab evidence", () => {
  assert.throws(
    () =>
      validateHomeLabEvidence(
        { ...report(), expiresAt: "2026-08-13" },
        { candidateDigest, sourceSha, today: "2026-08-14" },
      ),
    /must be unexpired/u,
  );
});

test("rejects evidence verified in the future", () => {
  assert.throws(
    () =>
      validateHomeLabEvidence(
        { ...report(), verifiedAt: "2026-08-15" },
        { candidateDigest, sourceSha, today: "2026-08-14" },
      ),
    /cannot be verified in the future/u,
  );
});

test("rejects an owner value that can disclose a network location", () => {
  assert.throws(
    () =>
      validateHomeLabEvidence(
        { ...report(), owner: "https://home-lab.example" },
        { candidateDigest, sourceSha, today: "2026-08-14" },
      ),
    /safe identifier/u,
  );
});

test("rejects upstream versions that can disclose a network location", () => {
  assert.throws(
    () =>
      validateHomeLabEvidence(
        { ...report(), upstream: { versions: { jellyfin: "https://home-lab.example" } } },
        { candidateDigest, sourceSha, today: "2026-08-14" },
      ),
    /safe identifier/u,
  );
});
