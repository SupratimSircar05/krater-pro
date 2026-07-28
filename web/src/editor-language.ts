const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bat: "bat",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dockerfile: "dockerfile",
  fs: "fsharp",
  fsx: "fsharp",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

function basename(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

export function monacoLanguageForPath(path: string) {
  const name = basename(path);
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  if (name === "makefile" || name.startsWith("makefile.")) {
    return "plaintext";
  }
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

export function editorResourceKey(projectId: string, path: string) {
  return `${projectId}:${path.replaceAll("\\", "/")}`;
}
