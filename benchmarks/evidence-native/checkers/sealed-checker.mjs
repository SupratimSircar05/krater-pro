#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const REPORT_FORMAT = "krater.sealed-checker-report/v1";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--task", "--workspace"].includes(flag) || !value || values.has(flag)) {
      throw new Error("Invalid sealed-checker invocation");
    }
    values.set(flag, value);
  }
  if (values.size !== 2) throw new Error("Missing sealed-checker argument");
  return { taskId: values.get("--task"), workspace: values.get("--workspace") };
}

function inside(parent, child) {
  const value = relative(parent, child);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

async function confinedFile(workspace, name) {
  const root = await realpath(workspace);
  const candidate = resolve(root, name);
  if (!inside(root, candidate)) throw new Error("Candidate escaped workspace");
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Candidate is not a regular file");
  const actual = await realpath(candidate);
  if (!inside(root, actual)) throw new Error("Candidate resolved outside workspace");
  return actual;
}

function attempt(callback) {
  try {
    return callback() === true;
  } catch {
    return false;
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadNode(workspace) {
  const path = await confinedFile(workspace, "src/solution.mjs");
  return await import(`${pathToFileURL(path).href}?sealed=${Date.now()}`);
}

async function checkNode(taskId, workspace) {
  const mod = await loadNode(workspace);
  switch (taskId) {
    case "EB-001":
      return [
        attempt(() => mod.parsePort("3000") === 3000),
        attempt(() => ["3000x", " 3", "-1", "0", "65536", ""].every((value) => {
          try { mod.parsePort(value); return false; } catch { return true; }
        })),
      ];
    case "EB-002":
      return [
        attempt(() => deepEqual(mod.stableUnique(["b", "a", "b", "c", "a"]), ["b", "a", "c"])),
        attempt(() => deepEqual(mod.stableUnique([0, -0, Number.NaN, Number.NaN]), [0, Number.NaN])),
      ];
    case "EB-003": {
      const input = [[5, 7], [1, 3], [2, 6], [10, 10]];
      const snapshot = JSON.stringify(input);
      return [
        attempt(() => deepEqual(mod.mergeIntervals(input), [[1, 7], [10, 10]])),
        attempt(() => JSON.stringify(input) === snapshot),
        attempt(() => {
          try { mod.mergeIntervals([[3, 1]]); return false; } catch { return true; }
        }),
      ];
    }
    case "EB-004":
      return [
        attempt(() => {
          const result = mod.orderJobs([
            { id: "test", dependsOn: ["build"] },
            { id: "build", dependsOn: ["lint"] },
            { id: "lint", dependsOn: [] },
          ]);
          return result.indexOf("lint") < result.indexOf("build") &&
            result.indexOf("build") < result.indexOf("test");
        }),
        attempt(() => {
          try {
            mod.orderJobs([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]);
            return false;
          } catch { return true; }
        }),
        attempt(() => {
          try { mod.orderJobs([{ id: "a", dependsOn: ["missing"] }]); return false; } catch { return true; }
        }),
      ];
    case "EB-005":
      return [
        attempt(() => deepEqual([0, 1, 2, 8].map((attemptNumber) =>
          mod.retryDelay(attemptNumber, 100, 500)), [100, 200, 400, 500])),
        attempt(() => {
          try { mod.retryDelay(-1, 100, 500); return false; } catch { return true; }
        }),
        attempt(() => Number.isSafeInteger(mod.retryDelay(1000, 100, 500))),
      ];
    case "EB-006":
      return [
        attempt(() => mod.isSafeChildPath("/safe/root", "/safe/root/src/a.ts") === true),
        attempt(() => [
          "/safe/root-evil/a.ts",
          "/safe/root/../secret",
          "/safe/root",
        ].every((candidate) => mod.isSafeChildPath("/safe/root", candidate) === false)),
      ];
    case "EB-007": {
      const input =
        "Authorization: Bearer abcd.efgh.ijkl\nKRATER_API_KEY=kr_live_secret123\nname=harmless";
      return [
        attempt(() => {
          const output = mod.redactSecrets(input);
          return !output.includes("abcd.efgh.ijkl") && !output.includes("kr_live_secret123");
        }),
        attempt(() => mod.redactSecrets(input).includes("name=harmless")),
        attempt(() => mod.redactSecrets("tokenizer and api_keynote").includes("tokenizer")),
      ];
    }
    case "EB-008": {
      const event = { type: "state", state: "staging", sequence: 2 };
      const canonical = JSON.stringify(event, Object.keys(event).sort());
      const expected = createHash("sha256").update(`abc123\n${canonical}`).digest("hex");
      return [
        attempt(() => mod.hashEvent("abc123", event) === expected),
        attempt(() => mod.hashEvent("other", event) !== expected),
        attempt(() => /^[a-f0-9]{64}$/.test(mod.hashEvent("", { z: 1, a: 2 }))),
      ];
    }
    case "EB-009": {
      return [
        attempt(() => {
          const cache = new mod.LruCache(2);
          cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3);
          return cache.get("a") === 1 && cache.get("b") === undefined && cache.get("c") === 3;
        }),
        attempt(() => {
          const cache = new mod.LruCache(1);
          cache.set("a", 1); cache.set("a", 2);
          return cache.size === 1 && cache.get("a") === 2;
        }),
        attempt(() => {
          try { new mod.LruCache(0); return false; } catch { return true; }
        }),
      ];
    }
    case "EB-010":
      return [
        attempt(() => mod.classifyAction({
          reproduced: false, acceptanceSatisfied: true, partialFix: false,
        }) === "already-satisfied"),
        attempt(() => mod.classifyAction({
          reproduced: true, acceptanceSatisfied: false, partialFix: true,
        }) === "partial-fix"),
        attempt(() => mod.classifyAction({
          reproduced: false, acceptanceSatisfied: false, partialFix: false,
        }) === "cannot-establish"),
      ];
    case "EB-019": {
      const secret = "benchmark-secret";
      return [
        attempt(() => deepEqual(mod.decodeCursor(mod.encodeCursor({ offset: 7 }, secret), secret), { offset: 7 })),
        attempt(() => {
          const token = mod.encodeCursor({ offset: 7 }, secret);
          const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
          try { mod.decodeCursor(tampered, secret); return false; } catch { return true; }
        }),
        attempt(() => {
          try { mod.decodeCursor(mod.encodeCursor({ offset: 7 }, secret), "wrong"); return false; } catch { return true; }
        }),
      ];
    }
    case "EB-020":
      return [
        attempt(() => mod.gradeClaim([{ kind: "runtime-observation", passed: true }]) === "observed"),
        attempt(() => mod.gradeClaim([
          { kind: "test", passed: true },
          { kind: "stress-test", passed: true },
        ]) === "stress-tested"),
        attempt(() => mod.gradeClaim([{ kind: "test", passed: false }]) === "not-established"),
        attempt(() => mod.gradeClaim([{ kind: "test", passed: true }]) !== "formally-verified"),
      ];
    default:
      throw new Error("Unknown Node benchmark task");
  }
}

const PYTHON_HARNESS = String.raw`
import importlib.util, json, sys
task_id, source = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("candidate", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def attempt(fn):
    try:
        return fn() is True
    except Exception:
        return False

checks = []
if task_id == "EB-011":
    checks = [
        attempt(lambda: module.parse_bool("true") is True and module.parse_bool("FALSE") is False),
        attempt(lambda: module.parse_bool(" 1 ") is True and module.parse_bool("0") is False),
        attempt(lambda: _must_raise(lambda: module.parse_bool("sometimes"))),
    ]
elif task_id == "EB-012":
    checks = [
        attempt(lambda: list(module.chunks([1,2,3,4], 2)) == [[1,2],[3,4]]),
        attempt(lambda: list(module.chunks([], 3)) == []),
        attempt(lambda: _must_raise(lambda: list(module.chunks([1], 0)))),
    ]
elif task_id == "EB-013":
    left = {"db": {"host": "a", "ports": [1]}, "keep": True}
    snapshot = json.dumps(left, sort_keys=True)
    merged = module.deep_merge(left, {"db": {"host": "b", "ssl": True}})
    checks = [
        attempt(lambda: merged == {"db": {"host": "b", "ports": [1], "ssl": True}, "keep": True}),
        attempt(lambda: json.dumps(left, sort_keys=True) == snapshot),
        attempt(lambda: module.deep_merge({}, {"nested": {"x": 1}}) is not None),
    ]
elif task_id == "EB-014":
    checks = [
        attempt(lambda: module.parse_csv_line('a,"b,c",d') == ["a","b,c","d"]),
        attempt(lambda: module.parse_csv_line('"a""b",c') == ['a"b',"c"]),
        attempt(lambda: module.parse_csv_line("a,b,") == ["a","b",""]),
    ]
elif task_id == "EB-015":
    now = [10.0]
    cache = module.TtlCache(lambda: now[0])
    cache.set("a", 1, 5.0)
    checks.append(attempt(lambda: cache.get("a") == 1))
    now[0] = 15.0
    checks.append(attempt(lambda: cache.get("a") is None))
    checks.append(attempt(lambda: _must_raise(lambda: cache.set("b", 2, 0))))
elif task_id == "EB-016":
    checks = [
        attempt(lambda: module.slugify("Crème brûlée!") == "creme-brulee"),
        attempt(lambda: module.slugify("  A---B___C  ") == "a-b-c"),
        attempt(lambda: module.slugify("!!!") == ""),
    ]
elif task_id == "EB-017":
    checks = [
        attempt(lambda: module.apply_edits("abcdef", [
            {"start": 1, "end": 3, "text": "X"},
            {"start": 4, "end": 6, "text": "Y"},
        ]) == "aXdY"),
        attempt(lambda: module.apply_edits("abc", []) == "abc"),
        attempt(lambda: _must_raise(lambda: module.apply_edits("abcdef", [
            {"start": 1, "end": 4, "text": "X"},
            {"start": 3, "end": 5, "text": "Y"},
        ]))),
    ]
elif task_id == "EB-018":
    checks = [
        attempt(lambda: module.join_labels(["public", "secret", "pii"]) == "secret"),
        attempt(lambda: module.join_labels([]) == "public"),
        attempt(lambda: _must_raise(lambda: module.join_labels(["unknown"]))),
    ]
else:
    raise ValueError("unknown Python benchmark task")
print(json.dumps(checks, separators=(",", ":")))

def _unreachable():
    return False
`;

// Define the helper before task execution without exposing expected values to the candidate.
const PYTHON_HELPER = `
def _must_raise(fn):
    try:
        fn()
        return False
    except Exception:
        return True
`;

async function checkPython(taskId, workspace) {
  const source = await confinedFile(workspace, "src/solution.py");
  const executable = process.platform === "win32" ? "python" : "python3";
  const harness = PYTHON_HARNESS.replace(
    "task_id, source = sys.argv[1], sys.argv[2]",
    `task_id, source = sys.argv[1], sys.argv[2]\n${PYTHON_HELPER}`,
  );
  const result = spawnSync(executable, ["-I", "-c", harness, taskId, source], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    maxBuffer: 32_768,
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Python candidate check failed");
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "boolean")) {
    throw new Error("Python harness returned an invalid result");
  }
  return parsed;
}

async function main() {
  let taskId = "unknown";
  try {
    const args = parseArguments(process.argv.slice(2));
    taskId = args.taskId;
    const python = /^EB-0(11|12|13|14|15|16|17|18)$/.test(taskId);
    const results = python
      ? await checkPython(taskId, args.workspace)
      : await checkNode(taskId, args.workspace);
    const checks = results.map((passed, index) => ({
      id: `behavior-${index + 1}`,
      passed,
    }));
    const passed = checks.length > 0 && checks.every((check) => check.passed);
    process.stdout.write(JSON.stringify({ format: REPORT_FORMAT, taskId, passed, checks }));
    process.exitCode = passed ? 0 : 1;
  } catch {
    const report = {
      format: REPORT_FORMAT,
      taskId,
      passed: false,
      checks: [{ id: "candidate-load", passed: false }],
    };
    process.stdout.write(JSON.stringify(report));
    process.exitCode = 1;
  }
}

await main();
