import { describe, expect, it } from "vitest";
import { loadSecretsIntoEnv } from "../src/secrets.js";

describe("loadSecretsIntoEnv", () => {
  it("does nothing when AWS_SECRETS_ID is not set", async () => {
    const env: NodeJS.ProcessEnv = { FOO: "bar" };
    await loadSecretsIntoEnv(env);
    expect(env).toEqual({ FOO: "bar" });
  });
});
