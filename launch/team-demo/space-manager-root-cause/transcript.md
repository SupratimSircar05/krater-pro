# Narration transcript

> Edited, narrated, credential-free screen demo assembled from sanitized live captures.

## 01-title — Space Manager root-cause evidence

This is a sanitized, edited screen demo of how Krater Pro narrows a Cisco Spaces Space Manager incident. The session is read only. It contains no credentials, cookies, or production changes.

## 02-live-symptom — The user-visible symptom

First, an authorized comparison capture shows the symptom family: location context is unavailable and the interface asks for a location. This capture is from a separate environment, so Krater treats it as a symptom reference, never as proof of the targeted incident.

## 03-monitor-overview — The incident is broad and repeatable

The dedicated target monitor provides the stronger evidence. The latest run is current, the incident is active, and all five Space Manager sections fail. Yet the daily hierarchy sweep still discovers and covers the target location.

## 04-pattern — The failure follows location state

Krater correlates the section results instead of treating them as five unrelated outages. Overview reports a location selection mismatch. The other sections report null location state. The monitored requests complete successfully, the Devices WebSocket upgrades and exchanges frames, and the User Management API and UI count match exactly.

## 05-reasoning — Krater's corrected diagnosis

Here is the authentic high-stakes Krater result, cropped to the corrected diagnosis only. It identifies the selection commit boundary: the switcher registers the target, Overview retains a stale location, and the other views receive null state. Krater labels this the strongest evidence-supported inference, not formal causal proof.

## 06-krater-workflow — One bounded fix and an exact recheck

The same authentic result turns the diagnosis into a bounded remediation. Commit the selected location to one shared store, prevent silent reversion, and make all five views subscribe to that source. Then select the target floor, verify Overview, verify zero nulls in the other views, run all five sections, and confirm availability moves off the recorded baseline.

## 07-proof — What must pass before we call it fixed

The fix is not complete when one page looks green. The recheck must prove that the selected location persists through all five sections and nested views, that API and UI values agree exactly, and that retries do not hide null state. Existing monitor and dashboard suites already pass locally, providing a stable baseline for that replay.

## 08-result — Focused diagnosis. No blind edit.

The result is a focused diagnosis without speculative production changes: one shared boundary to instrument, one targeted remediation path, and one replayable proof contract. That is how Krater Pro reduces time to root cause while keeping confidence proportional to evidence.
