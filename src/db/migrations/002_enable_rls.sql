-- Supabase exposes the public schema through its auto-generated REST API. With RLS enabled and
-- no policies, the anon/authenticated roles get no access at all; the backend connects as the
-- table owner, which bypasses RLS. On plain Postgres this is harmless.
ALTER TABLE creators         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_journals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
