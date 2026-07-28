import { createHmac } from "node:crypto";

export function verifyWebhook(request, secret, now, seen) {
  const signature = createHmac("sha256", secret).update(request.body).digest("hex");
  return signature === request.signature;
}
