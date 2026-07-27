"use strict";

const upstream = require("brace-expansion-v5");

function braceExpansion(pattern, options) {
  return upstream.expand(pattern, options);
}

// minimatch 3 and 5 require brace-expansion as a callable CommonJS export.
// minimatch 9 and 10 consume the modern named `expand` export. Preserve both
// contracts while delegating all parsing and CVE bounds to upstream 5.0.8.
braceExpansion.expand = upstream.expand;
braceExpansion.EXPANSION_MAX = upstream.EXPANSION_MAX;
braceExpansion.EXPANSION_MAX_LENGTH = upstream.EXPANSION_MAX_LENGTH;

module.exports = braceExpansion;
