import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

const servers: Server[] = [];
const temporaryPaths: string[] = [];

async function serve(): Promise<{ base: string; token: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "krater-advanced-api-"));
  temporaryPaths.push(cwd);
  const app = await createApp(loadConfig({ cwd }, {}));
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
