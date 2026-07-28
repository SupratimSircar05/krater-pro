import { mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIntentId } from "../intent/index.js";
import {
  INTENT_GRAPH_FILE,
  INTENT_MANIFEST_FILE,
  IntentFileStore,
  IntentFilesError,
} from "./index.js";

async function temporaryProject(): Promise<string> {
  const root = await realpath(tmpdir());
  return mkdtemp(join(root, "krater-intent-files-"));
}

describe("living intent files", () => {
  it("performs no writes until explicit initialization", async () => {
    const project = await temporaryProject();
    const directory = join(project, ".krater-intent");
    const store = new IntentFileStore(directory);

    expect(await store.isInitialized()).toBe(false);
    await expect(store.load()).rejects.toMatchObject({
      code: "not_initialized",
    });
    expect(await store.isInitialized()).toBe(false);

    await store.initialize({ namespace: "sample-project" });
    expect(await store.isInitialized()).toBe(true);
    expect(JSON.parse(await readFile(join(directory, INTENT_MANIFEST_FILE), "utf8")))
      .toEqual({
        schemaVersion: 1,
        format: "krater-living-intent",
        graphFile: "intents.json",
        namespace: "sample-project",
      });
  });

  it("writes deterministic, human-readable graphs with stable IDs", async () => {
    const project = await temporaryProject();
    const directory = join(project, ".krater-intent");
    const store = new IntentFileStore(directory);
    await store.initialize({ namespace: "example" });

    const first = await store.addIntent({
      kind: "requirement",
      statement: " Parser accepts escaped commas. ",
      stableKey: "parser accepts escaped commas",
    });
    const again = await store.addIntent({
      kind: "requirement",
      statement: "Parser accepts escaped commas.",
      stableKey: "  parser   accepts escaped commas ",
    });
    expect(first.intent.id).toBe(
      createIntentId(
        "requirement",
        "parser accepts escaped commas",
        "example",
      ),
    );
    expect(again.created).toBe(false);

    await store.upsertLink({
      fromIntentId: first.intent.id,
      target: { kind: "test", id: "parser.test.ts:escaped" },
      relation: "covers",
    });
    const before = await readFile(join(directory, INTENT_GRAPH_FILE), "utf8");
    await store.save(await store.load());
    const after = await readFile(join(directory, INTENT_GRAPH_FILE), "utf8");

    expect(after).toBe(before);
    expect(after).toContain('\n  "nodes": [');
    expect((await store.check()).valid).toBe(true);
  });

  it("uses the living graph validator for coverage and retirement", async () => {
    const project = await temporaryProject();
    const store = new IntentFileStore(join(project, ".krater-intent"));
    await store.initialize({ namespace: "retirement" });
    const oldIntent = await store.addIntent({
      kind: "requirement",
      statement: "Use the legacy parser.",
    });
    expect((await store.check()).uncoveredIntentIds).toEqual([
      oldIntent.intent.id,
    ]);
    await expect(
      store.retireIntent({
        intentId: oldIntent.intent.id,
        reason: "The new parser is safer.",
      }),
    ).rejects.toMatchObject({ code: "invalid_retirement" });

    const replacement = await store.addIntent({
      kind: "requirement",
      statement: "Use the RFC parser.",
    });
    await store.upsertLink({
      fromIntentId: replacement.intent.id,
      target: { kind: "test", id: "parser.test.ts:rfc" },
      relation: "fulfills",
    });
    await store.retireIntent({
      intentId: oldIntent.intent.id,
      reason: "Superseded by the RFC parser.",
      replacementIntentId: replacement.intent.id,
      retiredAt: "2026-07-28T00:00:00.000Z",
    });

    const checked = await store.check();
    expect(checked.valid).toBe(true);
    expect(checked.retiredIntentIds).toEqual([oldIntent.intent.id]);
    expect(checked.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("accepts an explicit owner decision as retirement authority", async () => {
    const project = await temporaryProject();
    const store = new IntentFileStore(join(project, ".krater-intent"));
    await store.initialize({ namespace: "owner-decision" });
    const intent = await store.addIntent({
      kind: "non_goal",
      statement: "Do not support XML.",
    });

    const graph = await store.retireIntent({
      intentId: intent.intent.id,
      reason: "Customer requirement changed.",
      ownerDecisionId: "decision:product:2026-07-28",
      retiredAt: "2026-07-28T00:00:00.000Z",
    });
    expect(graph.nodes.find((node) => node.id === intent.intent.id)).toMatchObject({
      status: "retired",
      retirement: {
        ownerDecisionId: "decision:product:2026-07-28",
      },
    });
  });

  it("refuses secret material without changing the artifact", async () => {
    const project = await temporaryProject();
    const directory = join(project, ".krater-intent");
    const secret = "unique-known-secret-value";
    const store = new IntentFileStore(directory, { secrets: [secret] });
    await store.initialize({ namespace: "safe" });
    const before = await readFile(join(directory, INTENT_GRAPH_FILE), "utf8");

    await expect(
      store.addIntent({
        kind: "assumption",
        statement: `The credential is ${secret}.`,
      }),
    ).rejects.toMatchObject({ code: "secret_detected" });
    expect(await readFile(join(directory, INTENT_GRAPH_FILE), "utf8")).toBe(before);

    await expect(
      store.addIntent({
        kind: "assumption",
        statement: "api_key=kr_example_1234567890123456",
      }),
    ).rejects.toMatchObject({ code: "secret_detected" });
  });

  it("rejects unsafe destinations and symlinked intent paths", async () => {
    const project = await temporaryProject();
    expect(
      () => new IntentFileStore(join(project, ".krater", ".krater-intent")),
    ).toThrow(IntentFilesError);
    expect(() => new IntentFileStore(join(project, "intent"))).toThrow(
      IntentFilesError,
    );

    if (process.platform !== "win32") {
      const elsewhere = await temporaryProject();
      const linked = join(project, ".krater-intent");
      await symlink(elsewhere, linked, "dir");
      const store = new IntentFileStore(linked);
      await expect(store.initialize()).rejects.toMatchObject({
        code: "unsafe_symlink",
      });
    }
  });
});
