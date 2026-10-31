import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type DbSslMode } from "./pool.js";
import { logger } from "../logger.js";
import { loadSecretsIntoEnv } from "../secrets.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
// Arbitrary constant: every instance that boots at the same time waits on this lock instead of racing.
const MIGRATION_LOCK_ID = 727_001;

async function main() {
  await loadSecretsIntoEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createPool(url, {
    sslMode: process.env.DATABASE_SSL as DbSslMode | undefined,
    sslCa: process.env.DATABASE_SSL_CA,
    max: 1,
  });
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      const sql = await readFile(join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info({ file }, "migration applied");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
    await db.end();
  }
}

main().catch((err) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
