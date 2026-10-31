import pg from "pg";

// Return NUMERIC/BIGINT as strings; we convert to bigint explicitly so we never lose precision on token amounts.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

/**
 * disable: plain TCP (local Postgres only)
 * require: TLS, server certificate not verified
 * verify:  TLS, server certificate verified against `ca` (Supabase CA from the dashboard) or system CAs
 */
export type DbSslMode = "disable" | "require" | "verify";

export type DbOptions = { sslMode?: DbSslMode; sslCa?: string; max?: number };

const isLocal = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host);

export function resolveSsl(databaseUrl: string, opts: DbOptions = {}): false | pg.ConnectionConfig["ssl"] {
  const url = new URL(databaseUrl);
  const mode = opts.sslMode ?? (isLocal(url.hostname) ? "disable" : "require");
  if (mode === "disable") return false;
  if (mode === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ...(opts.sslCa ? { ca: opts.sslCa.replace(/\\n/g, "\n") } : {}) };
}

/** `sslmode` in the URL would override our `ssl` object inside node-postgres, so we strip it and decide here. */
export function stripSslParams(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  for (const p of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(p);
  return url.toString();
}

export function createPool(databaseUrl: string, opts: DbOptions = {}): Db {
  return new pg.Pool({
    connectionString: stripSslParams(databaseUrl),
    ssl: resolveSsl(databaseUrl, opts),
    // Supabase's free session pooler allows a small number of connections; keep the pool modest.
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
