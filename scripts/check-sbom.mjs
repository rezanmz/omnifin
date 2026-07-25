import { readFile } from "node:fs/promises";
import process from "node:process";

const sbomPath = process.env.OMNIFIN_SBOM_PATH ?? "artifacts/sbom.spdx.json";
let document;
try {
  document = JSON.parse(await readFile(sbomPath, "utf8"));
} catch {
  process.stderr.write(`A readable SPDX JSON SBOM is required at ${sbomPath}.\n`);
  process.exit(1);
}

const errors = [];
if (document.spdxVersion !== "SPDX-2.3") errors.push("spdxVersion must be SPDX-2.3");
if (document.SPDXID !== "SPDXRef-DOCUMENT") errors.push("document SPDXID is missing");
if (
  typeof document.documentNamespace !== "string" ||
  !document.documentNamespace.startsWith("https://")
) {
  errors.push("documentNamespace must be an HTTPS URI");
}
if (!Array.isArray(document.packages) || document.packages.length === 0) {
  errors.push("at least one package is required");
}
if (
  !Array.isArray(document.creationInfo?.creators) ||
  document.creationInfo.creators.length === 0
) {
  errors.push("creationInfo.creators is required");
}

const serialized = JSON.stringify(document);
for (const forbidden of ["authorization", "client_secret", "password", "refresh_token"]) {
  if (serialized.toLowerCase().includes(forbidden))
    errors.push(`SBOM contains forbidden secret-like field: ${forbidden}`);
}

if (errors.length > 0) {
  process.stderr.write(`Invalid SBOM:\n- ${errors.join("\n- ")}\n`);
  process.exit(1);
}

process.stdout.write(`SPDX SBOM validation passed for ${document.packages.length} packages.\n`);
