export function negotiateAbi(host, plugin) {
  return host.version === plugin.version;
}
