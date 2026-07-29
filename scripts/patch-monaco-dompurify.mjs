import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MONACO_VERSION = "0.56.0";
const VULNERABLE_DECLARATION = "3.4.8";
const SECURE_DOMPURIFY_VERSION = "3.4.12";

function packagePath(root, packageName) {
  return join(root, "node_modules", ...packageName.split("/"), "package.json");
}

async function readPackage(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicJson(path, value) {
  const temporary = join(
    dirname(path),
    `.package-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * npm correctly installs the security override, but Monaco 0.56.0 publishes an
 * exact stale dependency declaration. npm sbom treats the resulting tree as
 * invalid even though the override is intentional. Patch only that metadata
 * after verifying both exact package versions; code bytes remain supplied by
 * the checksummed npm packages and the lockfile remains authoritative.
 */
export async function patchMonacoDomPurify(root = process.cwd()) {
  const workspaceRoot = resolve(root);
  const monacoPath = packagePath(workspaceRoot, "monaco-editor");
  const domPurifyPath = packagePath(workspaceRoot, "dompurify");
  const [monaco, domPurify] = await Promise.all([
    readPackage(monacoPath),
    readPackage(domPurifyPath),
  ]);
  if (monaco.name !== "monaco-editor" || monaco.version !== MONACO_VERSION) {
    throw new Error(
      `Refusing to patch unexpected Monaco package ${String(monaco.name)}@${String(monaco.version)}.`,
    );
  }
  if (
    domPurify.name !== "dompurify" ||
    domPurify.version !== SECURE_DOMPURIFY_VERSION
  ) {
    throw new Error(
      `The locked DOMPurify package must be ${SECURE_DOMPURIFY_VERSION} before Monaco metadata is patched.`,
    );
  }
  const declared = monaco.dependencies?.dompurify;
  if (declared === SECURE_DOMPURIFY_VERSION) {
    return { changed: false, monacoPath };
  }
  if (declared !== VULNERABLE_DECLARATION) {
    throw new Error(
      `Refusing to replace unexpected Monaco DOMPurify declaration ${String(declared)}.`,
    );
  }
  await atomicJson(monacoPath, {
    ...monaco,
    dependencies: {
      ...monaco.dependencies,
      dompurify: SECURE_DOMPURIFY_VERSION,
    },
  });
  return { changed: true, monacoPath };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await patchMonacoDomPurify();
  process.stdout.write(
    result.changed
      ? "Patched Monaco's DOMPurify dependency metadata to the locked secure override.\n"
      : "Monaco's DOMPurify dependency metadata already matches the secure override.\n",
  );
}
