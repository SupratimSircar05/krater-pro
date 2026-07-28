export function encodeCursor(value, secret) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(token, secret) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
}
