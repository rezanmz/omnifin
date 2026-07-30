#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const FIXTURE_MOVIE_TMDB_ID = 2_147_480_001;
export const FIXTURE_SERIES_TVDB_ID = 2_147_480_002;

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});
const XML_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/xml; charset=utf-8",
});

export function radarrFixtureMovie() {
  return {
    alternativeTitles: [],
    certifications: [],
    collection: null,
    credits: { cast: [], crew: [] },
    digitalRelease: "2026-01-02T00:00:00Z",
    genres: ["Science Fiction"],
    homepage: "",
    images: [],
    imdbId: "tt2147480001",
    inCinema: "2026-01-01T00:00:00Z",
    keywords: ["fixture"],
    movieRatings: null,
    originalLanguage: "en",
    originalTitle: "The Deterministic Meridian",
    overview: "A bounded synthetic title used only for isolated connector verification.",
    physicalRelease: null,
    popularity: 0,
    premier: "2026-01-01T00:00:00Z",
    ratings: [{ count: 1, origin: "fixture", type: "user", value: 1 }],
    recommendations: [],
    runtime: 90,
    status: "released",
    studio: "Omnifin Fixture Studio",
    title: "The Deterministic Meridian",
    titleSlug: "the-deterministic-meridian",
    tmdbId: FIXTURE_MOVIE_TMDB_ID,
    translations: [],
    year: 2026,
    youtubeTrailerId: "",
  };
}

export function sonarrFixtureSeries() {
  return {
    actors: [],
    aniListIds: [],
    contentRating: "TV-PG",
    episodes: [],
    firstAired: "2026-01-01",
    genres: ["Science Fiction"],
    images: [],
    imdbId: "tt2147480002",
    lastAired: "2026-01-01",
    malIds: [],
    network: "Omnifin Fixture Network",
    originalLanguage: "en",
    overview: "A bounded synthetic series used only for isolated connector verification.",
    rating: { count: 1, value: 1 },
    runtime: 45,
    seasons: [{ images: [], seasonNumber: 1 }],
    slug: "the-deterministic-signal",
    status: "continuing",
    timeOfDay: { hours: 20, minutes: 0 },
    title: "The Deterministic Signal",
    tmdbId: null,
    tvdbId: FIXTURE_SERIES_TVDB_ID,
    tvMazeId: null,
    tvRageId: null,
  };
}

export function newznabCapabilities() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.0" title="Omnifin Fixture Indexer" />
  <limits max="100" default="100" />
  <registration available="no" open="no" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q,imdbid,tmdbid" />
    <tv-search available="yes" supportedParams="q,tvdbid,season,ep" />
  </searching>
  <categories>
    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
  </categories>
</caps>`;
}

export function newznabFixtureFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
  <channel>
    <title>Omnifin Fixture Indexer</title>
    <description>Deterministic fixture feed</description>
    <link>http://fixture-indexer.omnifin.invalid:8080/</link>
    <newznab:response offset="0" total="1" />
    <item>
      <title>The.Deterministic.Signal.S01E01.1080p.WEB-DL</title>
      <guid isPermaLink="true">http://fixture-indexer.omnifin.invalid:8080/details/deterministic-signal-s01e01</guid>
      <link>http://fixture-indexer.omnifin.invalid:8080/nzb/deterministic-signal-s01e01.nzb</link>
      <pubDate>Wed, 01 Jan 2025 00:00:00 +0000</pubDate>
      <category>TV &gt; HD</category>
      <description>Deterministic fixture result</description>
      <enclosure url="http://fixture-indexer.omnifin.invalid:8080/nzb/deterministic-signal-s01e01.nzb" length="1048576" type="application/x-nzb" />
      <newznab:attr name="category" value="5000" />
      <newznab:attr name="size" value="1048576" />
      <newznab:attr name="guid" value="deterministic-signal-s01e01" />
    </item>
  </channel>
</rss>`;
}

function send(response, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
}

export function handleMetadataRequest(request, response) {
  if (request.method !== "GET") {
    send(response, 405, JSON_HEADERS, JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const host = request.headers.host?.split(":", 1)[0]?.toLowerCase();
  const url = new URL(request.url ?? "/", "https://fixture.invalid");
  if (url.pathname === "/healthz") {
    send(response, 200, JSON_HEADERS, JSON.stringify({ status: "ok" }));
    return;
  }
  if (host === "api.radarr.video" && url.pathname === `/v1/movie/${FIXTURE_MOVIE_TMDB_ID}`) {
    send(response, 200, JSON_HEADERS, JSON.stringify(radarrFixtureMovie()));
    return;
  }
  if (
    host === "skyhook.sonarr.tv" &&
    url.pathname === `/v1/tvdb/shows/en/${FIXTURE_SERIES_TVDB_ID}`
  ) {
    send(response, 200, JSON_HEADERS, JSON.stringify(sonarrFixtureSeries()));
    return;
  }
  if (host === "services.sonarr.tv" && url.pathname === "/v1/scenemapping") {
    send(response, 200, JSON_HEADERS, "[]");
    return;
  }
  if (
    host === "thexem.info" &&
    url.pathname === "/map/allNames" &&
    url.searchParams.size === 2 &&
    url.searchParams.get("origin") === "tvdb" &&
    url.searchParams.get("seasonNumbers") === "true"
  ) {
    send(response, 200, JSON_HEADERS, JSON.stringify({ data: {}, message: "", result: "success" }));
    return;
  }
  send(response, 404, JSON_HEADERS, JSON.stringify({ error: "not_found" }));
}

export function handleIndexerRequest(request, response) {
  if (request.method !== "GET") {
    send(response, 405, XML_HEADERS, '<error code="405" description="method_not_allowed" />');
    return;
  }
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (url.pathname === "/healthz") {
    send(response, 200, JSON_HEADERS, JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname !== "/api") {
    send(response, 404, XML_HEADERS, '<error code="404" description="not_found" />');
    return;
  }
  send(
    response,
    200,
    XML_HEADERS,
    url.searchParams.get("t") === "caps" ? newznabCapabilities() : newznabFixtureFeed(),
  );
}

async function closeServers(servers) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
    ),
  );
}

export async function startFixtureServers() {
  const tls = {
    cert: readFileSync("/fixture-tls/server.crt"),
    key: readFileSync("/fixture-tls/server.key"),
  };
  const servers = [
    createHttpsServer(tls, handleMetadataRequest),
    createHttpServer(handleIndexerRequest),
  ];
  await Promise.all([
    new Promise((resolvePromise) => servers[0].listen(443, "0.0.0.0", resolvePromise)),
    new Promise((resolvePromise) => servers[1].listen(8080, "0.0.0.0", resolvePromise)),
  ]);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await closeServers(servers);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { servers, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startFixtureServers();
}
