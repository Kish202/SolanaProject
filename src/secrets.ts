/**
 * On AWS, secrets (sponsor key, DB URL, ...) live in one Secrets Manager JSON secret named by
 * AWS_SECRETS_ID. They are loaded into process.env at boot so nothing sensitive sits in
 * Elastic Beanstalk environment properties or Terraform state. Values already set win.
 * Elsewhere (local, Render) this is a no-op and plain env vars are used.
 */
export async function loadSecretsIntoEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const secretId = env.AWS_SECRETS_ID;
  if (!secretId) return;
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error(`secret ${secretId} has no string value`);
  const values = JSON.parse(res.SecretString) as Record<string, unknown>;
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined && v !== null && v !== undefined) env[k] = String(v);
  }
}
