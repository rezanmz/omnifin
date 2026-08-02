"use client";

import type { RuntimeIdentity } from "@omnifin/contracts/runtime";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

function supportIdentity(identity: RuntimeIdentity) {
  return [
    `Omnifin ${identity.version} (${identity.channel})`,
    `Revision: ${identity.revision ?? "development"}`,
    `License: ${identity.license}`,
  ].join("\n");
}

export function RuntimeIdentityActions({ identity }: { identity: RuntimeIdentity }) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | "idle">("idle");

  return (
    <div className="about-passport__actions">
      <button
        className="about-passport__copy"
        onClick={() => {
          setCopyState("idle");
          if (!navigator.clipboard) {
            setCopyState("failed");
            return;
          }
          void navigator.clipboard
            .writeText(supportIdentity(identity))
            .then(() => setCopyState("copied"))
            .catch(() => setCopyState("failed"));
        }}
        type="button"
      >
        {copyState === "copied" ? (
          <Check aria-hidden="true" size={17} />
        ) : (
          <Copy aria-hidden="true" size={17} />
        )}
        Copy support identity
      </button>
      <span className="about-passport__copy-status" role="status">
        {copyState === "copied"
          ? "Support identity copied."
          : copyState === "failed"
            ? "Could not copy. Select the build details instead."
            : ""}
      </span>
    </div>
  );
}
