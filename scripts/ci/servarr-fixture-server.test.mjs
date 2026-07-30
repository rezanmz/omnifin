import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_MOVIE_TMDB_ID,
  FIXTURE_SERIES_TVDB_ID,
  handleIndexerRequest,
  handleMetadataRequest,
  newznabCapabilities,
  newznabFixtureFeed,
  radarrFixtureMovie,
  sonarrFixtureSeries,
} from "../integration/servarr-fixture-server.mjs";

function capture(handler, { host = "fixture.invalid", method = "GET", url = "/" }) {
  let body = "";
  let headers;
  let status;
  handler(
    { headers: { host }, method, url },
    {
      end(value = "") {
        body += value;
      },
      writeHead(value, responseHeaders) {
        status = value;
        headers = responseHeaders;
      },
    },
  );
  return { body, headers, status };
}

test("serves only the exact synthetic Radarr metadata identity", () => {
  const response = capture(handleMetadataRequest, {
    host: "api.radarr.video",
    url: `/v1/movie/${FIXTURE_MOVIE_TMDB_ID}`,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), radarrFixtureMovie());
  assert.equal(radarrFixtureMovie().tmdbId, FIXTURE_MOVIE_TMDB_ID);
  assert.equal(radarrFixtureMovie().credits.cast.length, 0);
  assert.equal(radarrFixtureMovie().credits.crew.length, 0);

  assert.equal(
    capture(handleMetadataRequest, {
      host: "api.radarr.video",
      url: `/v1/movie/${FIXTURE_MOVIE_TMDB_ID - 1}`,
    }).status,
    404,
  );
  assert.equal(
    capture(handleMetadataRequest, {
      host: "public.example",
      url: `/v1/movie/${FIXTURE_MOVIE_TMDB_ID}`,
    }).status,
    404,
  );
});

test("serves only the exact synthetic Sonarr metadata identity", () => {
  const response = capture(handleMetadataRequest, {
    host: "skyhook.sonarr.tv",
    url: `/v1/tvdb/shows/en/${FIXTURE_SERIES_TVDB_ID}`,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), sonarrFixtureSeries());
  assert.equal(sonarrFixtureSeries().tvdbId, FIXTURE_SERIES_TVDB_ID);
  assert.deepEqual(sonarrFixtureSeries().episodes, []);

  assert.equal(
    capture(handleMetadataRequest, {
      host: "skyhook.sonarr.tv",
      url: `/v1/tvdb/shows/en/${FIXTURE_SERIES_TVDB_ID - 1}`,
    }).status,
    404,
  );

  const sceneMappings = capture(handleMetadataRequest, {
    host: "services.sonarr.tv",
    url: "/v1/scenemapping",
  });
  assert.equal(sceneMappings.status, 200);
  assert.deepEqual(JSON.parse(sceneMappings.body), []);

  const xemMappings = capture(handleMetadataRequest, {
    host: "thexem.info",
    url: "/map/allNames?origin=tvdb&seasonNumbers=true",
  });
  assert.equal(xemMappings.status, 200);
  assert.deepEqual(JSON.parse(xemMappings.body), { data: {}, message: "", result: "success" });
  assert.equal(
    capture(handleMetadataRequest, {
      host: "thexem.info",
      url: "/map/all",
    }).status,
    404,
  );
  assert.equal(
    capture(handleMetadataRequest, {
      host: "thexem.info",
      url: "/map/allNames?origin=tvdb",
    }).status,
    404,
  );
});

test("exposes a deterministic private Newznab capability surface", () => {
  const capabilities = capture(handleIndexerRequest, { url: "/api?t=caps" });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body, newznabCapabilities());
  assert.match(capabilities.body, /category id="2000"/u);
  assert.match(capabilities.body, /category id="5000"/u);

  const emptySearch = capture(handleIndexerRequest, { url: "/api?t=search&q=fixture" });
  assert.equal(emptySearch.status, 200);
  assert.equal(emptySearch.body, newznabFixtureFeed());
  assert.match(emptySearch.body, /total="1"/u);
  assert.match(emptySearch.body, /The\.Deterministic\.Signal/u);
  assert.equal(capture(handleIndexerRequest, { url: "/unrelated" }).status, 404);
});

test("rejects mutation methods on every fixture endpoint", () => {
  assert.equal(capture(handleMetadataRequest, { method: "POST" }).status, 405);
  assert.equal(capture(handleIndexerRequest, { method: "POST", url: "/api" }).status, 405);
});
