import { z } from "zod";

if (typeof window !== "undefined") {
  // Configure validation before any browser contract schema is constructed.
  // Zod's object-schema JIT relies on Function construction, which the
  // production nonce-only script policy deliberately blocks.
  z.config({ jitless: true });
}
