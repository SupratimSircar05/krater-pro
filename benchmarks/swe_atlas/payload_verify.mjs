#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const ROOT = resolve(process.argv[2] ?? "/installed-agent");
const MANIFEST_PATH = `${ROOT}/payload-manifest.json`;

function fail(message) {
  throw new Error(`Krater Pro payload verification failed: ${message}`);
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function filesUnder(root, directory = root) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (!inside(root, path)) fail(`path escaped skills root: ${entry.name}`);
    const details = await lstat(path);
    if (details.isSymbolicLink()) fail(`symlink in skills payload: ${path}`);
    if (details.isDirectory()) {
      found.push(...(await filesUnder(root, path)));
    } else if (details.isFile()) {
      found.push(path);
    } else {
      fail(`non-regular skills payload entry: ${path}`);
    }
  }
  return found;
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
if (manifest?.schema !== 1) fail("unsupported manifest schema");

const bundle = manifest.bundle;
const bundlePath = resolve(ROOT, String(bundle?.path ?? ""));
if (!inside(ROOT, bundlePath)) fail("bundle path escaped install root");
const bundleDetails = await lstat(bundlePath);
if (!bundleDetails.isFile() || bundleDetails.isSymbolicLink()) {
  fail("bundle is not a regular file");
}
if (
  bundleDetails.size !== bundle.size ||
  (await sha256(bundlePath)) !== bundle.sha256
) {
  fail("bundle digest or size mismatch");
}

const skills = manifest.skills;
const skillsRoot = resolve(ROOT, String(skills?.root ?? ""));
if (!inside(ROOT, skillsRoot)) fail("skills path escaped install root");
const expected = Array.isArray(skills?.files) ? skills.files : fail("missing skills files");
const actualPaths = await filesUnder(skillsRoot);
const actualNames = actualPaths
  .map((path) => relative(skillsRoot, path).split(sep).join("/"))
  .sort();
const expectedNames = expected.map((record) => String(record.path)).sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  fail("skills file set mismatch");
}

const records = [];
for (const record of expected) {
  const name = String(record.path);
  if (!name || name.includes("\0") || name.includes("\n") || name.includes("\r")) {
    fail("unsafe skills manifest path");
  }
  const path = resolve(skillsRoot, name);
  if (!inside(skillsRoot, path)) fail(`skills path escaped root: ${name}`);
  const details = await lstat(path);
  const digest = await sha256(path);
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size !== record.size ||
    digest !== record.sha256
  ) {
    fail(`skills digest or size mismatch: ${name}`);
  }
  records.push(`${digest}\0${details.size}\0${name}\n`);
}
const skillsDigest = createHash("sha256").update(records.join("")).digest("hex");
if (skillsDigest !== skills.sha256) fail("skills tree digest mismatch");

process.stdout.write(
  `payload verified: bundle=${bundle.sha256} skills=${skills.sha256}\n`,
);
