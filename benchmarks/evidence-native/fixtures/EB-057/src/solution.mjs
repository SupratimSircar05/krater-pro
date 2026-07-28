export function validateResolvedAddresses(host, addresses) {
  return addresses.length > 0 && !addresses[0].startsWith("127.");
}
