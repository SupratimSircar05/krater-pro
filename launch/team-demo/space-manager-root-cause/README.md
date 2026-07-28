# Krater Pro × Cisco Spaces: Space Manager root-cause evidence demo

This package is a polished, credential-free team demo showing how Krater Pro narrows a Space Manager incident without making a speculative production change.

The MP4 is an **edited, narrated screen demo assembled from sanitized live captures**. It is not a continuous raw screen recording. That distinction is intentional: private identity data is removed, claims are scoped to recorded evidence, and the final root-cause statement remains an inference until source instrumentation confirms it.

## Watch

- `krater-pro-space-manager-root-cause-demo.mp4` — 1920×1080 H.264/AAC with an embedded English subtitle track and on-screen captions.
- `captions.vtt` — standalone English captions.
- `transcript.md` — complete narration transcript.

## What the demo establishes

- The targeted monitor reports an active incident with all five Space Manager sections failing.
- The hierarchy sweep still discovers and covers the target location.
- Overview reports `location_selection_mismatch`.
- Devices, Manage Rooms, Manage Desks, and User Management report `location_state_null`.
- The recorded requests complete successfully; the Devices row shows a successful WebSocket upgrade with frames, and the authentic Krater result records an exact User Management API/UI count.
- The cross-section pattern most strongly supports a shared front-end location-state handoff or hydration defect.
- The authentic Krater high-stakes result narrows the repair to the selection-commit boundary and provides a five-step live recheck.

## What the demo does not claim

- It does not claim that the comparison-environment screenshot is evidence from the targeted monitor.
- It does not claim that a specific source symbol is already proven defective.
- It does not claim that the incident has been repaired or that production was modified.
- It does not treat passing local monitor tests as proof that the live product issue is fixed.

Formal confirmation requires instrumentation at the shared location store / route-hydration boundary, followed by a replay proving non-null location state across all five sections and nested views.

## Evidence and privacy

See `evidence-manifest.json` for claim grades, source boundaries, verification results, and artifact digests. The render pipeline removes the visible user identity from the comparison capture, redacts monitor identifiers, and uses identifier-free excerpts from the authentic Krater diagnosis pane. The package contains no service identity, project path, tenant/customer ID, password, API key, cookie, authorization header, or private authentication state.

## Re-render

Requirements:

- Node.js with this repository’s locked `sharp` dependency.
- macOS `say` for the included narration workflow.
- An `ffmpeg` executable with H.264, AAC, and `mov_text` support.

```sh
FFMPEG_BIN=/absolute/path/to/ffmpeg \
  node launch/team-demo/space-manager-root-cause/scripts/render-demo.mjs
```

Optional narration controls:

```sh
KRATER_DEMO_VOICE=Samantha KRATER_DEMO_RATE=185 \
  FFMPEG_BIN=/absolute/path/to/ffmpeg \
  node launch/team-demo/space-manager-root-cause/scripts/render-demo.mjs
```

The render creates inspectable intermediates under `generated/`. Only the compact render receipt and QA contact sheet are intended for version control; audio, segments, slides, and extracted QA frames are reproducible and ignored.

## Suggested team handoff

1. Watch the MP4.
2. Review the `observed` versus `inferred` claims in `evidence-manifest.json`.
3. Instrument the shared location-state boundary.
4. Apply the smallest repair that preserves selected location through route and section changes.
5. Replay the same five-section monitor contract.
6. Close the incident only when the live monitor and exact API/UI checks agree.
