import type { D1Database } from "./types";
import {
  MAX_ACCOUNT_PROJECT_BYTES,
  MAX_PROJECTS,
} from "./security";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  issued_at: number;
  expires_at: number;
  user_email: string;
  user_created_at: number;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  snapshot_json: string;
  created_at: number;
  updated_at: number;
}

export const PROJECT_SQL = {
  list: `SELECT id, user_id, name, snapshot_json, created_at, updated_at
    FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${MAX_PROJECTS}`,
  get: `SELECT id, user_id, name, snapshot_json, created_at, updated_at
    FROM projects WHERE id = ? AND user_id = ?`,
  insert: `INSERT INTO projects
      (id, user_id, name, snapshot_json, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE
      (SELECT COUNT(*) FROM projects WHERE user_id = ?) < ?
      AND (
        SELECT COALESCE(SUM(LENGTH(CAST(snapshot_json AS BLOB))), 0)
        FROM projects WHERE user_id = ?
      ) + LENGTH(CAST(? AS BLOB)) <= ?
    RETURNING id, user_id, name, snapshot_json, created_at, updated_at`,
  update: `UPDATE projects SET name = ?, snapshot_json = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
      AND (
        SELECT COALESCE(SUM(LENGTH(CAST(snapshot_json AS BLOB))), 0)
        FROM projects WHERE user_id = ? AND id <> ?
      ) + LENGTH(CAST(? AS BLOB)) <= ?
    RETURNING id, user_id, name, snapshot_json, created_at, updated_at`,
  delete: "DELETE FROM projects WHERE id = ? AND user_id = ?",
  quota: `SELECT COUNT(*) AS project_count,
      COALESCE(SUM(LENGTH(CAST(snapshot_json AS BLOB))), 0) AS snapshot_bytes
    FROM projects WHERE user_id = ?`,
} as const;

export interface ProjectQuotaRow {
  project_count: number;
  snapshot_bytes: number;
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return db.prepare(
    `SELECT id, email, password_hash, password_salt, password_iterations, created_at, updated_at
      FROM users WHERE email = ?`,
  ).bind(email).first<UserRow>();
}

export async function findSession(
  db: D1Database,
  tokenHash: string,
): Promise<SessionRow | null> {
  return db.prepare(
    `SELECT s.token_hash, s.user_id, s.issued_at, s.expires_at,
      u.email AS user_email, u.created_at AS user_created_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(tokenHash).first<SessionRow>();
}

export async function listProjects(
  db: D1Database,
  userId: string,
): Promise<ProjectRow[]> {
  const result = await db.prepare(PROJECT_SQL.list).bind(userId).all<ProjectRow>();
  return result.results ?? [];
}

export async function getProject(
  db: D1Database,
  id: string,
  userId: string,
): Promise<ProjectRow | null> {
  return db.prepare(PROJECT_SQL.get).bind(id, userId).first<ProjectRow>();
}

export async function updateProject(
  db: D1Database,
  id: string,
  userId: string,
  name: string,
  snapshotJson: string,
  now: number,
): Promise<ProjectRow | null> {
  return db.prepare(PROJECT_SQL.update)
    .bind(
      name,
      snapshotJson,
      now,
      id,
      userId,
      userId,
      id,
      snapshotJson,
      MAX_ACCOUNT_PROJECT_BYTES,
    )
    .first<ProjectRow>();
}

export async function insertProject(
  db: D1Database,
  id: string,
  userId: string,
  name: string,
  snapshotJson: string,
  now: number,
): Promise<ProjectRow | null> {
  return db.prepare(PROJECT_SQL.insert)
    .bind(
      id,
      userId,
      name,
      snapshotJson,
      now,
      now,
      userId,
      MAX_PROJECTS,
      userId,
      snapshotJson,
      MAX_ACCOUNT_PROJECT_BYTES,
    )
    .first<ProjectRow>();
}

export async function getProjectQuota(
  db: D1Database,
  userId: string,
): Promise<ProjectQuotaRow> {
  const row = await db.prepare(PROJECT_SQL.quota)
    .bind(userId)
    .first<ProjectQuotaRow>();
  return row ?? { project_count: 0, snapshot_bytes: 0 };
}

export async function deleteProject(
  db: D1Database,
  id: string,
  userId: string,
): Promise<void> {
  await db.prepare(PROJECT_SQL.delete).bind(id, userId).run();
}
