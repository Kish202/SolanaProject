import { describe, expect, it } from "vitest";
import { resolveSsl, stripSslParams } from "../src/db/pool.js";

const SUPABASE = "postgresql://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";

describe("database SSL", () => {
  it("uses plain TCP for local Postgres by default", () => {
    expect(resolveSsl("postgres://u:p@localhost:5432/db")).toBe(false);
  });

  it("requires TLS for remote hosts like Supabase by default", () => {
    expect(resolveSsl(SUPABASE)).toEqual({ rejectUnauthorized: false });
  });

  it("verifies the server certificate against the provided CA", () => {
    expect(resolveSsl(SUPABASE, { sslMode: "verify", sslCa: "-----BEGIN CERTIFICATE-----\\nabc" })).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----\nabc",
    });
  });

  it("strips sslmode from the URL so it cannot override the ssl config", () => {
    expect(stripSslParams(`${SUPABASE}?sslmode=require`)).toBe(SUPABASE);
  });
});
