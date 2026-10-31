import { randomUUID } from "node:crypto";
import type { Db, DbClient } from "../db/pool.js";
import { assertBalanced, type Journal } from "./journal.js";

/**
 * Writes journals inside the caller's DB transaction. The (trade_id, kind) unique
 * constraint makes this idempotent: if settlement is retried after a crash, the
 * second insert is a no-op instead of double-counting fees.
 */
export async function writeJournals(client: DbClient, tradeId: string, journals: Journal[]): Promise<void> {
  for (const journal of journals) {
    assertBalanced(journal);
    const id = randomUUID();
    const res = await client.query(
      `INSERT INTO ledger_journals (id, trade_id, kind) VALUES ($1, $2, $3)
       ON CONFLICT (trade_id, kind) DO NOTHING`,
      [id, tradeId, journal.kind],
    );
    if (res.rowCount === 0) continue;
    for (const e of journal.entries) {
      await client.query(
        "INSERT INTO ledger_entries (journal_id, account, mint, amount) VALUES ($1, $2, $3, $4)",
        [id, e.account, e.mint, e.amount.toString()],
      );
    }
  }
}

export async function accountBalances(db: Db, accountPrefix: string): Promise<{ account: string; mint: string; balance: string }[]> {
  const { rows } = await db.query(
    `SELECT account, mint, SUM(amount)::text AS balance
       FROM ledger_entries WHERE account LIKE $1 || '%'
      GROUP BY account, mint ORDER BY account, mint`,
    [accountPrefix],
  );
  return rows;
}

/** Reconciliation check: every journal must net to zero. Returns offending journal ids. */
export async function findUnbalancedJournals(db: Db): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT journal_id FROM ledger_entries GROUP BY journal_id, mint HAVING SUM(amount) <> 0`,
  );
  return rows.map((r: { journal_id: string }) => r.journal_id);
}
