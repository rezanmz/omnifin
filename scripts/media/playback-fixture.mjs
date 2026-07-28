#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const JELLYFIN_FIXTURE_IMAGE =
  "ghcr.io/jellyfin/jellyfin:10.11.11@sha256:45f648c382a0c8b552582fcea40e95cb17c5d475473a891cba0eb7523fb92112";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const FFMPEG = "/usr/lib/jellyfin-ffmpeg/ffmpeg";
const FFPROBE = "/usr/lib/jellyfin-ffmpeg/ffprobe";
const FIXTURE_NAME = "omnifin-playback-fixture.mp4";
const SEEK_FIXTURE_NAME = "omnifin-seek-transcode.mp4";
const REPORT_NAME = "playback-fixture-report.json";
const MINIMUM_FIXTURE_BYTES = 100_000;
const MINIMUM_SEEK_FIXTURE_BYTES = 25_000;
const MAXIMUM_FIXTURE_BYTES = 12 * 1_024 * 1_024;

class FixtureFailure extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "FixtureFailure";
    this.code = code;
  }
}

function parseArguments(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !arguments_[1]) {
    throw new FixtureFailure("usage_invalid");
  }
  const outputDirectory = resolve(REPOSITORY_ROOT, arguments_[1]);
  const relativePath = relative(REPOSITORY_ROOT, outputDirectory);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new FixtureFailure("output_path_invalid");
  }
  return { outputDirectory };
}

function dockerRuntimeArguments(outputDirectory, entrypoint) {
  const userId = process.getuid?.();
  const groupId = process.getgid?.();
  if (userId === undefined || groupId === undefined) {
    throw new FixtureFailure("platform_unsupported");
  }
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--user",
    `${userId}:${groupId}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m,mode=1777",
    "--mount",
    `type=bind,src=${outputDirectory},dst=/fixture`,
    "--workdir",
    "/fixture",
    "--entrypoint",
    entrypoint,
    JELLYFIN_FIXTURE_IMAGE,
  ];
}

function runTool(outputDirectory, entrypoint, arguments_, captureOutput = false) {
  try {
    return execFileSync(
      "docker",
      [...dockerRuntimeArguments(outputDirectory, entrypoint), ...arguments_],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        maxBuffer: 4 * 1_024 * 1_024,
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
        timeout: 180_000,
      },
    );
  } catch (error) {
    throw new FixtureFailure(entrypoint === FFPROBE ? "probe_failed" : "transcode_failed", {
      cause: error,
    });
  }
}

async function prepareOutputDirectory(outputDirectory) {
  const outputParent = dirname(outputDirectory);
  await mkdir(outputParent, { mode: 0o700, recursive: true });
  const canonicalRoot = await realpath(REPOSITORY_ROOT);
  const canonicalParent = await realpath(outputParent);
  const relativeParent = relative(canonicalRoot, canonicalParent);
  if (relativeParent.startsWith("..") || isAbsolute(relativeParent)) {
    throw new FixtureFailure("output_path_invalid");
  }
  let metadata;
  try {
    metadata = await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FixtureFailure("output_path_invalid");
  }
  if ((await readdir(outputDirectory)).length > 0) {
    throw new FixtureFailure("output_not_empty");
  }
  await rmdir(outputDirectory);
}

async function createWorkingDirectory() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omnifin-media-fixture-"));
  const workingDirectory = await realpath(temporaryDirectory);
  try {
    await writeSubtitleSources(workingDirectory);
    await mkdir(resolve(workingDirectory, "hls"), { mode: 0o700 });
    return workingDirectory;
  } catch (error) {
    await rm(workingDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function publishFixture(workingDirectory, outputDirectory) {
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  );
  try {
    const generatedEntries = await readdir(workingDirectory);
    for (const entry of generatedEntries) {
      await cp(resolve(workingDirectory, entry), resolve(stagingDirectory, entry), {
        errorOnExist: true,
        force: false,
        recursive: true,
      });
    }
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function writeSubtitleSources(outputDirectory) {
  const subtitles = [
    {
      name: "english.srt",
      text: `1
00:00:01,000 --> 00:00:04,000
Omnifin playback fixture

2
00:00:06,000 --> 00:00:10,000
Synthetic picture, tone, and captions
`,
    },
    {
      name: "french.srt",
      text: `1
00:00:01,000 --> 00:00:04,000
Séquence de lecture Omnifin

2
00:00:06,000 --> 00:00:10,000
Image, son et sous-titres synthétiques
`,
    },
  ];
  await Promise.all(
    subtitles.map(({ name, text }) =>
      writeFile(resolve(outputDirectory, name), text, { flag: "wx", mode: 0o600 }),
    ),
  );
}

function generateFixture(outputDirectory) {
  runTool(outputDirectory, FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24:duration=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:sample_rate=48000:duration=12",
    "-i",
    "/fixture/english.srt",
    "-i",
    "/fixture/french.srt",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "2:a:0",
    "-map",
    "3:s:0",
    "-map",
    "4:s:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-b:v",
    "900k",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-ac",
    "2",
    "-c:s",
    "mov_text",
    "-metadata",
    "title=Omnifin synthetic playback fixture",
    "-metadata:s:a:0",
    "language=eng",
    "-metadata:s:a:0",
    "title=English tone",
    "-metadata:s:a:1",
    "language=fra",
    "-metadata:s:a:1",
    "title=French tone",
    "-metadata:s:s:0",
    "language=eng",
    "-metadata:s:s:0",
    "title=English captions",
    "-metadata:s:s:1",
    "language=fra",
    "-metadata:s:s:1",
    "title=French captions",
    "-movflags",
    "+faststart",
    "-t",
    "12",
    `/fixture/${FIXTURE_NAME}`,
  ]);
}

function generateHlsTranscode(outputDirectory) {
  runTool(outputDirectory, FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    `/fixture/${FIXTURE_NAME}`,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-vf",
    "scale=320:180",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    "-sc_threshold",
    "0",
    "-b:v",
    "350k",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    "/fixture/hls/segment-%03d.ts",
    "/fixture/hls/index.m3u8",
  ]);
}

function generateSeekTranscode(outputDirectory) {
  runTool(outputDirectory, FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "4",
    "-i",
    `/fixture/${FIXTURE_NAME}`,
    "-t",
    "2",
    "-map",
    "0:v:0",
    "-map",
    "0:a:1",
    "-vf",
    "scale=320:180",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    `/fixture/${SEEK_FIXTURE_NAME}`,
  ]);
}

function probe(outputDirectory, fixtureName) {
  const output = runTool(
    outputDirectory,
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=index,codec_name,codec_type,width,height,avg_frame_rate:stream_tags=language,title",
      "-of",
      "json",
      `/fixture/${fixtureName}`,
    ],
    true,
  );
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new FixtureFailure("probe_invalid", { cause: error });
  }
}

function normalizedStreams(probeReport, type) {
  if (!Array.isArray(probeReport?.streams)) throw new FixtureFailure("probe_invalid");
  return probeReport.streams.filter((stream) => stream?.codec_type === type);
}

export function validateFixtureProbe(probeReport) {
  const duration = Number.parseFloat(probeReport?.format?.duration);
  const video = normalizedStreams(probeReport, "video");
  const audio = normalizedStreams(probeReport, "audio");
  const subtitles = normalizedStreams(probeReport, "subtitle");
  if (!Number.isFinite(duration) || duration < 11.9 || duration > 12.1) {
    throw new FixtureFailure("fixture_duration_invalid");
  }
  if (
    video.length !== 1 ||
    video[0].codec_name !== "h264" ||
    video[0].width !== 640 ||
    video[0].height !== 360 ||
    video[0].avg_frame_rate !== "24/1"
  ) {
    throw new FixtureFailure("fixture_video_invalid");
  }
  if (
    audio.length !== 2 ||
    audio.some((stream) => stream.codec_name !== "aac") ||
    audio.map((stream) => stream.tags?.language).join(",") !== "eng,fra"
  ) {
    throw new FixtureFailure("fixture_audio_invalid");
  }
  if (
    subtitles.length !== 2 ||
    subtitles.some((stream) => stream.codec_name !== "mov_text") ||
    subtitles.map((stream) => stream.tags?.language).join(",") !== "eng,fra"
  ) {
    throw new FixtureFailure("fixture_subtitle_invalid");
  }
  return {
    audioLanguages: audio.map((stream) => stream.tags.language),
    durationSeconds: duration,
    subtitleLanguages: subtitles.map((stream) => stream.tags.language),
    video: {
      codec: video[0].codec_name,
      frameRate: video[0].avg_frame_rate,
      height: video[0].height,
      width: video[0].width,
    },
  };
}

export function validateSeekProbe(probeReport) {
  const duration = Number.parseFloat(probeReport?.format?.duration);
  const video = normalizedStreams(probeReport, "video");
  const audio = normalizedStreams(probeReport, "audio");
  if (
    !Number.isFinite(duration) ||
    duration < 1.9 ||
    duration > 2.1 ||
    video.length !== 1 ||
    video[0].codec_name !== "h264" ||
    video[0].width !== 320 ||
    video[0].height !== 180 ||
    audio.length !== 1 ||
    audio[0].codec_name !== "aac" ||
    audio[0].tags?.language !== "fra"
  ) {
    throw new FixtureFailure("seek_transcode_invalid");
  }
  return { audioLanguage: "fra", durationSeconds: duration, height: 180, width: 320 };
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function assertFixtureSize(filePath, minimumBytes = MINIMUM_FIXTURE_BYTES) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < minimumBytes || metadata.size > MAXIMUM_FIXTURE_BYTES) {
    throw new FixtureFailure("fixture_size_invalid");
  }
  return metadata.size;
}

async function validateHls(outputDirectory) {
  const hlsDirectory = resolve(outputDirectory, "hls");
  const playlist = await readFile(resolve(hlsDirectory, "index.m3u8"), "utf8");
  const segmentNames = (await readdir(hlsDirectory))
    .filter((name) => /^segment-[0-9]{3}\.ts$/u.test(name))
    .sort();
  if (
    !playlist.startsWith("#EXTM3U\n") ||
    !playlist.includes("#EXT-X-ENDLIST") ||
    segmentNames.length < 5 ||
    segmentNames.some((name) => !playlist.includes(name))
  ) {
    throw new FixtureFailure("hls_transcode_invalid");
  }
  const segmentBytes = await Promise.all(
    segmentNames.map(async (name) => (await stat(resolve(hlsDirectory, name))).size),
  );
  if (segmentBytes.some((bytes) => bytes < 1_024 || bytes > 2 * 1_024 * 1_024)) {
    throw new FixtureFailure("hls_transcode_invalid");
  }
  return { playlist: "hls/index.m3u8", segmentCount: segmentNames.length };
}

async function main(options) {
  await prepareOutputDirectory(options.outputDirectory);
  const workingDirectory = await createWorkingDirectory();
  try {
    generateFixture(workingDirectory);
    const fixturePath = resolve(workingDirectory, FIXTURE_NAME);
    const fixtureBytes = await assertFixtureSize(fixturePath);
    const fixture = validateFixtureProbe(probe(workingDirectory, FIXTURE_NAME));

    generateHlsTranscode(workingDirectory);
    const hls = await validateHls(workingDirectory);

    generateSeekTranscode(workingDirectory);
    const seekPath = resolve(workingDirectory, SEEK_FIXTURE_NAME);
    const seekBytes = await assertFixtureSize(seekPath, MINIMUM_SEEK_FIXTURE_BYTES);
    const seek = validateSeekProbe(probe(workingDirectory, SEEK_FIXTURE_NAME));

    const report = {
      fixture: {
        ...fixture,
        bytes: fixtureBytes,
        fileName: FIXTURE_NAME,
        sha256: await sha256(fixturePath),
      },
      hls,
      image: JELLYFIN_FIXTURE_IMAGE,
      schemaVersion: 1,
      seekTranscode: {
        ...seek,
        bytes: seekBytes,
        fileName: SEEK_FIXTURE_NAME,
        sha256: await sha256(seekPath),
      },
      status: "passed",
    };
    await writeFile(
      resolve(workingDirectory, REPORT_NAME),
      `${JSON.stringify(report, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await publishFixture(workingDirectory, options.outputDirectory);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof FixtureFailure ? error.code : "fixture_generation_failed";
    process.stderr.write(`${JSON.stringify({ code, status: "failed" })}\n`);
    process.exitCode = 1;
  }
}
