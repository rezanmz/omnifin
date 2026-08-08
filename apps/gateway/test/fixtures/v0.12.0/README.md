# Omnifin v0.12.0 migration fixture

`v0.12.0.sqlite` is generated from the exact migration catalog at source commit
`b85488b9517680d59ef87dfdb90ad6ec04da5251`
(`v0.12.0`) and ends at migration `0031_playback_preferences`. It includes one deterministic,
test-only encrypted connector row so the Phase 0 legacy key sampling path is exercised.

The key in `provenance.json` is public fixture material and must never be used by a deployment.
Regenerate or verify locally with:

```sh
pnpm --filter @omnifin/gateway exec tsx scripts/generate-v012-fixture.ts
pnpm --filter @omnifin/gateway exec tsx scripts/generate-v012-fixture.ts --verify
```

When Docker is available, replace provisional source evidence using the exact immutable v0.12 image,
then recreate it independently for verification:

```sh
pnpm --filter @omnifin/gateway exec tsx scripts/generate-v012-fixture.ts \
  --image ghcr.io/rezanmz/omnifin@sha256:<v0.12-digest>
pnpm --filter @omnifin/gateway exec tsx scripts/generate-v012-fixture.ts \
  --verify --image ghcr.io/rezanmz/omnifin@sha256:<v0.12-digest>
```

Image mode creates and starts a hardened temporary container, generates the fixture solely with the
image's shipped gateway and `EnvelopeCipher`, and extracts the artifact with `docker cp`; host code
only checksums it and validates a copy with the candidate. Provenance is published last and records
`provisional:false` only after image generation and candidate validation both succeed. Source mode is
explicitly provisional and refuses to overwrite non-provisional evidence.

Docker was unavailable when Phase 0 was implemented. The checked-in fixture and checksum are
therefore provisional source-generated evidence, not immutable-image evidence. This does not weaken
or replace the v1 immutable-image release gate.
