import { createHash } from "node:crypto";

export function hashEvent(previousHash, event) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}
