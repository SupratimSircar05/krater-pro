export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  meta?: Record<string, unknown>;
  results?: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<Array<D1Result<T>>>;
}

export interface CloudEnv {
  DB: D1Database;
  RATE_LIMIT_SALT?: string;
  PASSWORD_PEPPER?: string;
}

export interface PagesFunctionContext<Env = CloudEnv> {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  waitUntil(promise: Promise<unknown>): void;
}

export type PagesFunction<Env = CloudEnv> = (
  context: PagesFunctionContext<Env>,
) => Response | Promise<Response>;
