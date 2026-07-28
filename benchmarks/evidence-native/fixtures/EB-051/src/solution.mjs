export function verifyClientData(expectedChallenge, allowedOrigins, data) {
  return data.challenge === expectedChallenge;
}
