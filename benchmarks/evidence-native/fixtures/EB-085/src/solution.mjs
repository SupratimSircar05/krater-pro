export function negotiateProtocol(client, server) {
  return { version: Math.max(...client.versions), extensions: client.extensions };
}
