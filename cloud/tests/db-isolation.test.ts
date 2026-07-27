import { describe, expect, it } from "vitest";
import {
  PROJECT_SQL,
  deleteProject,
  getProject,
  insertProject,
  listProjects,
  updateProject,
} from "../lib/db";
import {
  MAX_ACCOUNT_PROJECT_BYTES,
  MAX_PROJECTS,
} from "../lib/security";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../lib/types";

class CaptureStatement implements D1PreparedStatement {
  values: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly captures: CaptureStatement[],
  ) {
    captures.push(this);
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] };
  }

  async run<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] };
  }
}

class CaptureDatabase implements D1Database {
  readonly statements: CaptureStatement[] = [];

  prepare(query: string): D1PreparedStatement {
    return new CaptureStatement(query, this.statements);
  }

  async batch<T>(): Promise<Array<D1Result<T>>> {
    return [];
  }
}

describe("D1 project isolation", () => {
  it("scopes every project read and mutation to user_id", () => {
    expect(PROJECT_SQL.list).toMatch(/WHERE user_id = \?/u);
    expect(PROJECT_SQL.get).toMatch(/WHERE id = \? AND user_id = \?/u);
    expect(PROJECT_SQL.update).toMatch(/WHERE id = \? AND user_id = \?/u);
    expect(PROJECT_SQL.delete).toMatch(/WHERE id = \? AND user_id = \?/u);
  });

  it("binds the authenticated user to every query", async () => {
    const db = new CaptureDatabase();
    await listProjects(db, "user-a");
    await getProject(db, "project-1", "user-b");
    await insertProject(db, "project-new", "user-c", "Name", "{}", 122);
    await updateProject(db, "project-2", "user-c", "Name", "{}", 123);
    await deleteProject(db, "project-3", "user-d");

    expect(db.statements[0]?.values).toEqual(["user-a"]);
    expect(db.statements[1]?.values).toEqual(["project-1", "user-b"]);
    expect(db.statements[2]?.values).toEqual([
      "project-new",
      "user-c",
      "Name",
      "{}",
      122,
      122,
      "user-c",
      MAX_PROJECTS,
      "user-c",
      "{}",
      MAX_ACCOUNT_PROJECT_BYTES,
    ]);
    expect(db.statements[3]?.values).toEqual([
      "Name",
      "{}",
      123,
      "project-2",
      "user-c",
      "user-c",
      "project-2",
      "{}",
      MAX_ACCOUNT_PROJECT_BYTES,
    ]);
    expect(db.statements[4]?.values).toEqual(["project-3", "user-d"]);
  });

  it("enforces count and aggregate UTF-8 byte quotas inside atomic writes", () => {
    expect(MAX_PROJECTS).toBe(10);
    expect(MAX_ACCOUNT_PROJECT_BYTES).toBe(524_288);
    expect(PROJECT_SQL.insert).toMatch(
      /INSERT INTO projects[\s\S]+SELECT[\s\S]+COUNT\(\*\)[\s\S]+< \?/u,
    );
    expect(PROJECT_SQL.insert).toMatch(
      /SUM\(LENGTH\(CAST\(snapshot_json AS BLOB\)\)\)[\s\S]+LENGTH\(CAST\(\? AS BLOB\)\) <= \?/u,
    );
    expect(PROJECT_SQL.update).toMatch(
      /WHERE id = \? AND user_id = \?[\s\S]+WHERE user_id = \? AND id <> \?[\s\S]+LENGTH\(CAST\(\? AS BLOB\)\) <= \?/u,
    );
  });
});
