import assert from "node:assert/strict";
import test from "node:test";

import { runHealthcheck } from "../../docker/healthcheck.mjs";

const localHealth = "http://127.0.0.1:4000/healthz";
const localReadiness = "http://127.0.0.1:4000/readyz";

function jsonResponse(status, responseStatus = 200) {
  return Response.json({ status }, { status: responseStatus });
}

test("accepts the canonical liveness and readiness status contracts", async () => {
  for (const status of ["ok", "ready"]) {
    const requests = [];
    const result = await runHealthcheck([localReadiness], {
      fetch: async (url, options) => {
        requests.push({ options, url: url.href });
        return jsonResponse(status);
      },
    });

    assert.equal(result, 0);
    assert.equal(requests[0].url, localReadiness);
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(requests[0].options.headers.accept, "application/json");
    assert.ok(requests[0].options.signal instanceof AbortSignal);
  }
});

test("falls back across local roles after non-success and malformed responses", async () => {
  const responses = [
    new Response(null, { status: 503 }),
    new Response("not-json", { headers: { "content-type": "application/json" }, status: 200 }),
    jsonResponse("ready"),
  ];
  const result = await runHealthcheck([localHealth, localHealth, localReadiness], {
    fetch: async () => responses.shift(),
  });

  assert.equal(result, 0);
  assert.equal(responses.length, 0);
});

test("rejects unexpected application states and exhausted local targets", async () => {
  assert.equal(
    await runHealthcheck([localReadiness], { fetch: async () => jsonResponse("degraded") }),
    1,
  );
  assert.equal(
    await runHealthcheck([localReadiness], {
      fetch: async () => {
        throw new Error("redirect rejected");
      },
    }),
    1,
  );
});

test("rejects malformed and non-loopback destinations before making a request", async () => {
  let requests = 0;
  const fetch = async () => {
    requests += 1;
    return jsonResponse("ok");
  };

  assert.equal(await runHealthcheck(["not a URL"], { fetch }), 64);
  assert.equal(await runHealthcheck(["https://127.0.0.1:4000/healthz"], { fetch }), 64);
  assert.equal(await runHealthcheck(["http://gateway:4000/healthz"], { fetch }), 64);
  assert.equal(requests, 0);
});
