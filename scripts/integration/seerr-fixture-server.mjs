#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const SEERR_FIXTURE_TMDB_ID = 2_147_480_003;

const FIXTURE_TITLE = "The Deterministic Horizon";
const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});
const ALLOWED_QUERY_KEYS = new Set([
  "api_key",
  "append_to_response",
  "include_video_language",
  "language",
]);

export function seerrMovieFixture() {
  return {
    adult: false,
    backdrop_path: null,
    budget: 0,
    credits: { cast: [], crew: [] },
    external_ids: { imdb_id: null, tvdb_id: null },
    genres: [{ id: 878, name: "Science Fiction" }],
    homepage: "",
    id: SEERR_FIXTURE_TMDB_ID,
    imdb_id: null,
    keywords: { keywords: [] },
    original_language: "en",
    original_title: FIXTURE_TITLE,
    overview: "A bounded synthetic title used only for isolated request verification.",
    popularity: 0,
    poster_path: null,
    production_companies: [],
    production_countries: [],
    release_date: "2026-01-03",
    release_dates: { results: [] },
    revenue: 0,
    runtime: 90,
    spoken_languages: [{ english_name: "English", iso_639_1: "en", name: "English" }],
    status: "Released",
    tagline: "",
    title: FIXTURE_TITLE,
    video: false,
    videos: { results: [] },
    vote_average: 0,
    vote_count: 0,
    "watch/providers": { id: SEERR_FIXTURE_TMDB_ID, results: {} },
  };
}

function send(response, status, body) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

export function handleSeerrMetadataRequest(request, response) {
  if (request.method !== "GET") {
    send(response, 405, { error: "method_not_allowed" });
    return;
  }
  const host = request.headers.host?.split(":", 1)[0]?.toLowerCase();
  const url = new URL(request.url ?? "/", "https://fixture.invalid");
  if (url.pathname === "/healthz") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (
    host !== "api.themoviedb.org" ||
    url.pathname !== `/3/movie/${SEERR_FIXTURE_TMDB_ID}` ||
    [...url.searchParams.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key)) ||
    !url.searchParams.get("api_key") ||
    url.searchParams.get("language") !== "en"
  ) {
    send(response, 404, { error: "not_found" });
    return;
  }
  send(response, 200, seerrMovieFixture());
}

export async function startSeerrFixtureServer() {
  const server = createServer(
    {
      cert: readFileSync("/fixture-tls/server.crt"),
      key: readFileSync("/fixture-tls/server.key"),
    },
    handleSeerrMetadataRequest,
  );
  await new Promise((resolvePromise) => server.listen(443, "0.0.0.0", resolvePromise));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolvePromise) => server.close(resolvePromise));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { server, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startSeerrFixtureServer();
}
