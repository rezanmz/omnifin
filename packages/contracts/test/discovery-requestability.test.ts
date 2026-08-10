import { readFileSync } from "node:fs";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import type { DiscoveryAvailability, DiscoveryMediaRecordState } from "../src/discovery.js";
import { isDiscoveryMediaRequestable } from "../src/discovery-requestability.js";

const requestabilityMatrix: Record<
  DiscoveryAvailability,
  Record<DiscoveryMediaRecordState, boolean>
> = {
  available: { present: false, absent: false, unknown: false },
  partial: { present: true, absent: true, unknown: false },
  requested: { present: false, absent: false, unknown: false },
  processing: { present: false, absent: false, unknown: false },
  unavailable: { present: true, absent: true, unknown: false },
  unknown: { present: false, absent: true, unknown: false },
};

describe("discovery requestability", () => {
  for (const availability of Object.keys(requestabilityMatrix) as DiscoveryAvailability[]) {
    for (const mediaRecordState of Object.keys(
      requestabilityMatrix[availability],
    ) as DiscoveryMediaRecordState[]) {
      it(`treats ${availability}+${mediaRecordState} requestability as ${String(requestabilityMatrix[availability][mediaRecordState])}`, () => {
        expect(isDiscoveryMediaRequestable({ availability, mediaRecordState })).toBe(
          requestabilityMatrix[availability][mediaRecordState],
        );
      });
    }
  }

  it("keeps the source leaf free of runtime module imports and re-exports", () => {
    const source = readFileSync(
      new URL("../src/discovery-requestability.ts", import.meta.url),
      "utf8",
    );
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
      fileName: "discovery-requestability.ts",
    }).outputText;
    const output = ts.createSourceFile(
      "discovery-requestability.js",
      transpiled,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const runtimeModuleSyntax: ts.Node[] = [];

    function inspect(node: ts.Node) {
      if (
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
        (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")))
      ) {
        runtimeModuleSyntax.push(node);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(output);

    expect(runtimeModuleSyntax).toHaveLength(0);
  });

  it("publishes the leaf through the contracts package export map", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, { default: string; types: string }>;
    };

    expect(manifest.exports["./discovery-requestability"]).toEqual({
      default: "./dist/discovery-requestability.js",
      types: "./dist/discovery-requestability.d.ts",
    });
  });
});
