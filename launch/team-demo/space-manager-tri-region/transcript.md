# Narration transcript

> Edited, narrated, credential-free team demo. No production mutation was performed.

## 01-title — Space Manager across US, EU & SG

This credential-free team demo shows how Krater Pro combines read-only Cisco Spaces observations across the US, Europe, and Singapore with monitor telemetry and public production source maps. No account was changed, and the conclusion remains proportional to the evidence.

## 02-tri-region — One visible outcome across US, EU and SG

In three authorized, read-only sessions, the US, Europe, and Singapore validation overviews each displayed Please select a location. Their initial captures also said that building and floor selection was unavailable because the permitted locations had no published Rich Map.

## 03-separate-outcomes — Configuration outcome ≠ selection defect

Krater does not merge unlike evidence. The three validation captures establish a Rich Map configuration outcome in those environments. They are useful comparisons, but they do not prove the separate location selection defect reproduced in the US incident environment.

## 04-runtime-reproduction — Visible selection never commits

The stronger runtime reproduction comes from a separate US incident environment. Space Manager defaulted to BGL 15 and First Floor. On two read-only attempts, BGL 17 was visible and chosen, yet the selector and header remained on BGL 15. That is an exact reproduction of the monitor's location selection mismatch.

## 05-monitor-evidence — The transport works; location state does not

The sanitized latest full monitor run sharpens the boundary. All five sections failed and availability was zero percent over thirty runs. But every recorded request succeeded: six of six, six of six, three of three, four of four, and one of one. Devices upgraded its WebSocket with HTTP 101 and received eighteen frames. User Management matched exactly at API 327 and UI 327.

## 06-bundle-parity — US, EU and SG shipped the same code

Krater then checks production artifact provenance. The Space Manager JavaScript bundle is byte identical across US, Europe, and Singapore. The shared location hierarchy bundle is also byte identical across all three. This does not prove identical configuration or data, but it rules out a regional code fork for these two artifacts.

## 07-source-lh — Three proven selection behaviors

Public source maps provide source-level behaviors. The shared location hierarchy dispatches the first hierarchy node when full tree data changes, without a local nonempty guard at that line. A click callback ignores null deselection before invoking single location selection. Selection is also explicitly access gated, rejecting nodes whose access is Read unless the application role can bypass that check. These are verified behaviors and plausible failure surfaces, not proof that any one caused this incident.

## 08-source-sm — Null can be stopped before shared state

The Space Manager source map adds another verified boundary. Its middleware skips location wrap updates with null or undefined payloads. The application slice initializes selected location, selected floor location, and selected floor to null. Together, these behaviors show exactly where an empty hierarchy or access-rejected selection could leave downstream consumers without location state.

## 09-evidence-ladder — What is proved — and what is not

Krater's strongest supported conclusion is a shared client location selection and state propagation problem. Access gating and empty hierarchy handling are code-level suspects. Backend authentication, HTTP transport, the realtime channel, and at least one exact API to UI path were broadly available. The exact causal state transition remains not established until an intervention changes the outcome as predicted.

## 10-krater-result — A diagnosis with an epistemic label

The authentic Krater result records the same epistemic limit: strongest evidence-supported inference, not formal causal proof. The shared screenshot is aggressively cropped so no local path, project identity, email, account identifier, cookie, or credential appears.

## 11-proof-contract — How we will know the defect is fixed

The repair contract is concrete. Selecting BGL 17 and Seventh Floor must update the visible selector and header. All five sections and nested views must receive non-null location state. Exact API and UI parity must remain intact. The full monitor must pass repeatedly, and availability must move off the thirty-run zero percent baseline.

## 12-result — Source-level focus. No false certainty.

The outcome is source-level focus without false certainty: one shared client boundary to instrument, two concrete suspect behaviors to test, and a production replay contract that can confirm or reject causality.
