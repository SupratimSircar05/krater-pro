# Krater Pro × Cisco Spaces — tri-region Space Manager evidence

This package is an **edited, narrated, credential-free team demo**, not a continuous raw screen recording. It combines sanitized read-only captures, a sanitized monitoring payload, production bundle hashes, and tiny source excerpts recovered from public production source maps.

## Deliverables

- `krater-pro-space-manager-tri-region-demo.mp4` — 1920×1080 H.264/AAC video with embedded English subtitles.
- `evidence-manifest.json` — claim-to-evidence mapping, capture URLs, timestamps, hashes, limitations, and privacy statement.
- `storyboard.md` and `storyboard.json` — scene plan and narration.
- `transcript.md` and `captions.vtt` — accessible narration and timed captions.
- `generated/render-receipt.json` — deterministic input/output hashes and stream metadata.
- `generated/qa/contact-sheet.png` — timeline QA sample.
- `generated/sanitized/` — identity-redacted stills used by the video.

## Honest conclusion

The direct evidence supports a shared client location-selection/state-propagation problem. Explicit access gating and empty-hierarchy handling are source-level suspects. The evidence argues against a broad authentication, HTTP, backend, or WebSocket outage.

It does **not** establish the exact causal source transition. Causal confirmation still requires a controlled intervention followed by the same five-section production replay.

The US, EU, and SG validation captures show a separate Rich Map configuration outcome. They are not presented as proof of the US incident-environment selection defect.

## Privacy and scope

- The six private source screenshots and one private Krater screenshot were moved out of the repository after sanitized rendering; the ignore rule prevents accidental reintroduction.
- The renderer overlays or crops every identity-bearing header before use.
- No email address, user identity, tenant/account identifier, credential, cookie, token, authorization header, or private user-table data is included in shareable outputs.
- The monitor payload is represented only by a hand-selected, account-free summary.
- No Cisco site access or mutation is performed by the renderer.
- The renderer reads production bundles and source maps only from `/tmp/krater-space-source.iziwQL`.

## Rebuild

Requirements:

- Node.js with the repository's `sharp` dependency.
- macOS `say` for local narration.
- An `ffmpeg` executable with H.264, AAC, and `mov_text`.

```sh
FFMPEG_BIN=/absolute/path/to/ffmpeg \
  node launch/team-demo/space-manager-tri-region/scripts/render-demo.mjs
```

Optional:

```sh
KRATER_DEMO_VOICE=Samantha \
KRATER_DEMO_RATE=184 \
FFMPEG_BIN=/absolute/path/to/ffmpeg \
  node launch/team-demo/space-manager-tri-region/scripts/render-demo.mjs
```

The renderer fails closed if the expected bundle hashes, source-map excerpts, monitoring run, or private inputs do not match the captured evidence.
