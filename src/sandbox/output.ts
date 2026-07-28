import { createHash } from "node:crypto";
import type {
  BoundedProcessOutput,
  NativeOutputChunk,
} from "./types.js";

function asBuffer(value: Uint8Array | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

export function boundProcessOutput(
  chunks: readonly NativeOutputChunk[],
  maximumBytes: number,
  observedBytes?: number,
): BoundedProcessOutput {
  let remaining = maximumBytes;
  let capturedBytes = 0;
  let calculatedObservedBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const hash = createHash("sha256");

  for (const chunk of chunks) {
    const bytes = asBuffer(chunk.data);
    calculatedObservedBytes += bytes.byteLength;
    hash.update(bytes);
    if (remaining <= 0) continue;
    const captured = bytes.subarray(0, remaining);
    capturedBytes += captured.byteLength;
    remaining -= captured.byteLength;
    (chunk.stream === "stdout" ? stdout : stderr).push(captured);
  }

  const totalObserved = Math.max(calculatedObservedBytes, observedBytes ?? 0);
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    capturedBytes,
    observedBytes: totalObserved,
    truncated: totalObserved > capturedBytes,
    sha256: `sha256:${hash.digest("hex")}`,
  };
}

export function emptyBoundedOutput(): BoundedProcessOutput {
  return boundProcessOutput([], 1, 0);
}
