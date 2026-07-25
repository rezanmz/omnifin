import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkWorkflowPins, parseUses } from "./check-workflow-pins.mjs";

async function withRepository(files, callback) {
  const root = await mkdtemp(join(tmpdir(), "omnifin-action-pins-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolutePath = join(root, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    }
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("parses a full action pin and its reviewable version", () => {
  const [action] = parseUses(
    "steps:\n  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
  );
  assert.deepEqual(action, {
    line: 2,
    local: false,
    reference: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1",
  });
});

test("structurally finds quoted and flow-map uses keys", () => {
  const actions = parseUses(
    ["steps:", '  - "uses": actions/checkout@v7', "  - { uses: actions/setup-node@v7 }", ""].join(
      "\n",
    ),
  );
  assert.deepEqual(
    actions.map(({ line, reference, sha }) => ({ line, reference, sha })),
    [
      { line: 2, reference: "actions/checkout@v7", sha: null },
      { line: 3, reference: "actions/setup-node@v7", sha: null },
    ],
  );
});

test("recognizes local reusable workflows", () => {
  const [action] = parseUses('uses: "./.github/workflows/publish.yml"\n');
  assert.deepEqual(action, {
    line: 1,
    local: true,
    reference: "./.github/workflows/publish.yml",
  });
});

test("rejects unpinned actions hidden behind quoted or flow-map keys", async () => {
  await withRepository(
    {
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: push",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        '      - "uses": actions/checkout@v7',
        "      - { uses: actions/setup-node@v7 }",
        "",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(
        checkWorkflowPins({ root }),
        /actions\/checkout@v7.*actions\/setup-node@v7/su,
      );
    },
  );
});

test("recursively checks remote uses in nested local composite actions", async () => {
  await withRepository(
    {
      ".github/actions/inner/action.yml": [
        "name: Inner",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - { uses: actions/setup-node@v7 }",
        "",
      ].join("\n"),
      ".github/actions/outer/action.yaml": [
        "name: Outer",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - uses: ./.github/actions/inner",
        "",
      ].join("\n"),
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: push",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: ./.github/actions/outer",
        "",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(checkWorkflowPins({ root }), /actions\/setup-node@v7/u);
    },
  );
});
