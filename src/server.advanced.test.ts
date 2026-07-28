import { createServer as createHttpServer, type Server } from "node:http";
import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createApp, type ServerOptions } from "./server.js";

const servers: Server[] = [];
const temporaryPaths: string[] = [];

async function serve(
  options: ServerOptions = {},
): Promise<{ base: string; token: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "krater-advanced-api-"));
  temporaryPaths.push(cwd);
  const app = await createApp(loadConfig({ cwd }, {}), options);
  const server = await new Promise<Server>((resolveServer, reject) => {
    const instance = createHttpServer(app);
    instance.listen(0, "127.0.0.1", () => resolveServer(instance));
    instance.once("error", reject);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port.");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    token: String(app.locals.localToken),
    cwd,
  };
}

function post(
  server: { base: string; token: string },
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-krater-local-token": server.token,
    },
    body: JSON.stringify(body),
  });
}

function recordedCausalInput() {
  return {
    plan: {
      id: "api-causal",
      snapshotDigest: `sha256:${"b".repeat(64)}`,
      baseline: { runtime: "python", entrypoint: "fixture.py" },
      hypotheses: [
        {
          id: "configuration",
          statement: "Configuration causes the failure.",
          baselineExpectation: { keys: ["exit:1"] },
        },
        {
          id: "fixture",
          statement: "Fixture data causes the failure.",
          baselineExpectation: { keys: ["exit:1"] },
        },
      ],
      experiments: [
        {
          id: "toggle",
          title: "Toggle configuration",
          intervention: {
            kind: "configuration",
            description: "Use safe configuration.",
            changedInputs: ["mode"],
            isolated: true,
          },
          invocation: { runtime: "python", entrypoint: "fixture.py" },
          estimatedCost: 1,
          predictions: [
            { hypothesisId: "configuration", expected: { keys: ["success"] } },
            { hypothesisId: "fixture", expected: { keys: ["exit:1"] } },
          ],
        },
      ],
    },
    executions: [
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ],
  };
}

function evaluation(id: string, resolved: number, role = "private_holdout") {
  return {
    evaluationId: id,
    suiteId: role === "private_holdout" ? "holdout" : "rules",
    datasetDigest: role === "private_holdout" ? "holdout-v1" : "rules-v1",
    role,
    configurationDigest: `config-${id}`,
    sealed: true,
    cases: Array.from({ length: 20 }, (_, index) => ({
      caseId:
        role === "private_holdout" ? `holdout-${index}` : `training-${index}`,
      taskClass: "repair",
      resolved: index < resolved,
      securityFailures: 0,
      abstention: "not_applicable",
    })),
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    ),
  );
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("advanced evidence-native API adapters", () => {
  it("forecasts caller-supplied semantic conflicts without reading or mutating the workspace", async () => {
    const server = await serve();
    await writeFile(join(server.cwd, "sentinel.txt"), "unchanged\n");
    const pathsBefore = await readdir(server.cwd);

    const response = await post(server, "/api/v2/merge/forecast", {
      patches: [
        {
          id: "feature-a",
          symbols: [
            {
              id: "src/auth.ts#login",
              operation: "write",
              contractDigest: "contract-a",
            },
          ],
          invariants: [
            { id: "auth:no-plaintext", effect: "preserves" },
          ],
        },
        {
          id: "feature-b",
          symbols: [
            {
              id: "src/auth.ts#login",
              operation: "signature_change",
              contractDigest: "contract-b",
            },
          ],
          invariants: [
            { id: "auth:no-plaintext", effect: "weakens" },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      type: "semantic_merge_forecast",
      analysis: {
        source: "caller_supplied_descriptors",
        workspaceRead: false,
        workspaceMutation: false,
        executedChecks: false,
        persisted: false,
      },
      forecast: {
        safeToCombine: false,
        blockingConflictCount: 2,
        conflicts: [
          expect.objectContaining({ category: "invariant" }),
          expect.objectContaining({ category: "symbol" }),
        ],
      },
      limitations: expect.arrayContaining([
        expect.stringMatching(/caller-supplied/i),
        expect.stringMatching(/does not inspect Git/i),
        expect.stringMatching(/does not mutate/i),
      ]),
    });
    expect(await readFile(join(server.cwd, "sentinel.txt"), "utf8")).toBe(
      "unchanged\n",
    );
    expect(await readdir(server.cwd)).toEqual(pathsBefore);
  });

  it("strictly rejects unsupported fields, unsafe path syntax, and malformed touches", async () => {
    const server = await serve();
    const invalidBodies = [
      {
        patches: [{ id: "a" }],
        workspacePath: "/tmp/untrusted",
      },
      {
        patches: [{ id: "a", path: "../outside" }],
      },
      {
        patches: [{ id: "../outside" }],
      },
      {
        patches: [
          {
            id: "a",
            symbols: [{ id: "/etc/passwd", operation: "read" }],
          },
        ],
      },
      {
        patches: [
          {
            id: "a",
            schemas: [{ id: "User", operation: "rewrite" }],
          },
        ],
      },
      {
        patches: [
          {
            id: "a",
            migrations: [{ id: "m1", resource: "db", order: -1 }],
          },
        ],
      },
    ];

    for (const body of invalidBodies) {
      const response = await post(server, "/api/v2/merge/forecast", body);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain("/tmp/untrusted");
      expect(text).not.toContain("../outside");
      expect(text).not.toContain("/etc/passwd");
    }
  });

  it("reports semantic duplicate IDs as conflicts while enforcing a bounded schema", async () => {
    const server = await serve();
    const duplicate = await post(server, "/api/v2/merge/forecast", {
      patches: [{ id: "same" }, { id: "same" }],
    });

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      forecast: {
        safeToCombine: false,
        conflicts: [
          expect.objectContaining({
            category: "duplicate_patch",
            target: "same",
          }),
        ],
      },
    });

    const oversized = await post(server, "/api/v2/merge/forecast", {
      patches: Array.from({ length: 65 }, (_, index) => ({
        id: `patch-${index}`,
      })),
    });
    expect(oversized.status).toBe(400);
    expect(JSON.stringify(await oversized.json())).toMatch(/at most|1 to 64/i);
  });

  it("replays causal evidence but refuses to imply live execution", async () => {
    const server = await serve();
    const response = await post(
      server,
      "/api/v2/debug/causal",
      recordedCausalInput(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      executedProcesses: boolean;
      report: { verdict: string };
    };
    expect(body.executedProcesses).toBe(false);
    expect(body.report.verdict).toBe("causal_evidence_established");

    const refused = await post(server, "/api/v2/debug/causal", {
      ...recordedCausalInput(),
      executions: [],
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(
      /requires recorded executions/i,
    );
  });

  it("routes live causal requests through the selected local project without relabeling recorded replay", async () => {
    let selectedWorkspace = "";
    const server = await serve({
      liveCausalExecutor: (async (_value, options) => {
        selectedWorkspace = options.workspaceRoot;
        return {
          schemaVersion: 1,
          mode: "live_sandboxed_process_execution",
          executedProcesses: true,
          workspaceDigestVerified: true,
        } as never;
      }),
    });
    const response = await post(server, "/api/v2/debug/causal/live", {
      plan: {},
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "live_sandboxed_process_execution",
      executedProcesses: true,
      workspaceDigestVerified: true,
    });
    expect(selectedWorkspace).toBe(await realpath(server.cwd));
  });

  it("scores sealed results and evaluates promotion without persisting it", async () => {
    const server = await serve();
    const replay = await post(server, "/api/v2/lab/replay", {
      evaluation: evaluation("candidate", 15),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      executedBenchmarks: false,
      metrics: { resolutionRate: 75 },
    });

    const calibration = await post(server, "/api/v2/lab/calibrate", {
      candidateId: "router-v2",
      candidateKind: "router",
      ruleGeneration: evaluation("rules", 20, "rule_generation"),
      baselineHoldout: evaluation("baseline", 10),
      candidateHoldout: evaluation("candidate", 11),
    });
    expect(calibration.status).toBe(200);
    const calibrationBody = (await calibration.json()) as {
      persistedPromotion: boolean;
      decision: { promote: boolean; improvementPoints: number };
    };
    expect(calibrationBody).toMatchObject({
      persistedPromotion: false,
      decision: {
        promote: true,
      },
    });
    expect(calibrationBody.decision.improvementPoints).toBeCloseTo(5);
  });
});
