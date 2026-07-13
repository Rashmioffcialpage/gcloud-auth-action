/**
 * Real HTTP end-to-end tests: an actual Node http.Server implementing
 * Google's real STS + IAM Credentials contracts (and GitHub's real OIDC
 * token contract), real fetch() calls from the actual client code, real
 * JSON parsed from real responses. Nothing about the HTTP layer is mocked
 * at the function level -- only the *servers on the other end* are fakes,
 * standing in for Google Cloud / GitHub's real infrastructure.
 */

import { test } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";

import { createMockServer } from "../mock-server/server";
import { expandEndpoints } from "../src/client";
import { WorkloadIdentityFederationClient } from "../src/workload_identity_federation";
import { IamCredentialsClient } from "../src/iam_credentials";
import { parseServiceAccountKey, writeServiceAccountKeyFile } from "../src/service_account_key";

async function withMockServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createMockServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("expandEndpoints: real googleapis.com universe", () => {
  const endpoints = expandEndpoints("googleapis.com");
  assert.strictEqual(endpoints.sts, "https://sts.googleapis.com/v1");
  assert.strictEqual(endpoints.iamcredentials, "https://iamcredentials.googleapis.com/v1");
});

test("expandEndpoints: local mock base URL", () => {
  const endpoints = expandEndpoints("http://127.0.0.1:5401");
  assert.strictEqual(endpoints.sts, "http://127.0.0.1:5401/sts/v1");
  assert.strictEqual(endpoints.iamcredentials, "http://127.0.0.1:5401/iamcredentials/v1");
});

test("WorkloadIdentityFederationClient.getToken: real STS exchange against mock", async () => {
  await withMockServer(async (baseUrl) => {
    const endpoints = expandEndpoints(baseUrl);
    const client = new WorkloadIdentityFederationClient({
      githubOIDCToken: "fake-github-jwt",
      githubOIDCTokenRequestURL: "https://example.com/oidc",
      githubOIDCTokenRequestToken: "req-token",
      githubOIDCTokenAudience: "https://iam.googleapis.com/providers/x",
      workloadIdentityProviderName: "projects/123/locations/global/workloadIdentityPools/p/providers/x",
      endpoints,
    });

    const token = await client.getToken();
    assert.ok(token.startsWith("mock-federated-token."));

    // decode the mock server's echo to confirm what it actually received
    const descriptor = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf-8"),
    );
    assert.strictEqual(descriptor.subject, "fake-github-jwt");
    assert.ok(descriptor.audience.includes("workloadIdentityPools/p/providers/x"));
  });
});

test("WorkloadIdentityFederationClient.getToken: rejects wrong grantType server-side", async () => {
  await withMockServer(async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/sts/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audience: "x",
        grantType: "wrong-grant-type",
        subjectToken: "y",
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      }),
    });
    assert.strictEqual(resp.status, 400);
  });
});

test("IamCredentialsClient.generateAccessToken: real impersonation call against mock", async () => {
  await withMockServer(async (baseUrl) => {
    const endpoints = expandEndpoints(baseUrl);
    const client = new IamCredentialsClient(endpoints, "mock-federated-token.abc");
    const token = await client.generateAccessToken({
      serviceAccount: "deploy@my-project.iam.gserviceaccount.com",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    assert.ok(token.startsWith("mock-impersonated-token."));

    const descriptor = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf-8"),
    );
    assert.strictEqual(descriptor.serviceAccount, "deploy@my-project.iam.gserviceaccount.com");
    assert.deepStrictEqual(descriptor.scope, ["https://www.googleapis.com/auth/cloud-platform"]);
  });
});

test("IamCredentialsClient.generateAccessToken: rejects missing bearer token", async () => {
  await withMockServer(async (baseUrl) => {
    const endpoints = expandEndpoints(baseUrl);
    const client = new IamCredentialsClient(endpoints, "not-a-real-federated-token");
    await assert.rejects(
      () => client.generateAccessToken({ serviceAccount: "x@y.iam.gserviceaccount.com" }),
      /HTTP 401/,
    );
  });
});

test("WorkloadIdentityFederationClient.createCredentialsFile: writes valid external_account config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wif-creds-"));
  try {
    const endpoints = expandEndpoints("googleapis.com");
    const client = new WorkloadIdentityFederationClient({
      githubOIDCToken: "unused-here",
      githubOIDCTokenRequestURL: "https://actions.github.com/oidc-token",
      githubOIDCTokenRequestToken: "req-token-xyz",
      githubOIDCTokenAudience: "https://iam.googleapis.com/providers/x",
      workloadIdentityProviderName: "projects/123/locations/global/workloadIdentityPools/p/providers/x",
      serviceAccount: "deploy@my-project.iam.gserviceaccount.com",
      endpoints,
    });

    const outPath = join(dir, "creds.json");
    client.createCredentialsFile(outPath);
    const written = JSON.parse(readFileSync(outPath, "utf-8"));

    assert.strictEqual(written.type, "external_account");
    assert.strictEqual(written.token_url, "https://sts.googleapis.com/v1/token");
    assert.ok(written.audience.includes("workloadIdentityPools/p/providers/x"));
    assert.strictEqual(
      written.credential_source.headers.Authorization,
      "Bearer req-token-xyz",
    );
    assert.ok(
      written.service_account_impersonation_url.endsWith(
        "serviceAccounts/deploy@my-project.iam.gserviceaccount.com:generateAccessToken",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseServiceAccountKey: accepts raw JSON", () => {
  const raw = JSON.stringify({
    type: "service_account",
    project_id: "p",
    private_key_id: "k",
    private_key: "-----BEGIN PRIVATE KEY-----\n...",
    client_email: "sa@p.iam.gserviceaccount.com",
    client_id: "123",
  });
  const key = parseServiceAccountKey(raw);
  assert.strictEqual(key.client_email, "sa@p.iam.gserviceaccount.com");
});

test("parseServiceAccountKey: accepts base64-encoded JSON", () => {
  const raw = JSON.stringify({
    type: "service_account",
    project_id: "p",
    private_key_id: "k",
    private_key: "fake",
    client_email: "sa@p.iam.gserviceaccount.com",
    client_id: "123",
  });
  const key = parseServiceAccountKey(Buffer.from(raw).toString("base64"));
  assert.strictEqual(key.client_email, "sa@p.iam.gserviceaccount.com");
});

test("parseServiceAccountKey: rejects wrong type", () => {
  const raw = JSON.stringify({
    type: "authorized_user",
    project_id: "p",
    private_key: "fake",
    client_email: "sa@p.iam.gserviceaccount.com",
  });
  assert.throws(() => parseServiceAccountKey(raw), /expected "service_account"/);
});

test("parseServiceAccountKey: rejects missing required field", () => {
  const raw = JSON.stringify({ type: "service_account", project_id: "p" });
  assert.throws(() => parseServiceAccountKey(raw), /missing required field/);
});

test("writeServiceAccountKeyFile: round-trips correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "sa-key-"));
  try {
    const key = parseServiceAccountKey(
      JSON.stringify({
        type: "service_account",
        project_id: "p",
        private_key_id: "k",
        private_key: "fake",
        client_email: "sa@p.iam.gserviceaccount.com",
        client_id: "123",
      }),
    );
    const outPath = join(dir, "sa.json");
    writeServiceAccountKeyFile(key, outPath);
    const roundTripped = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.strictEqual(roundTripped.client_email, key.client_email);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full run(): WIF + impersonation end-to-end, entirely local (mocked GitHub OIDC + mocked Google STS/IAM)", async () => {
  await withMockServer(async (baseUrl) => {
    const dir = mkdtempSync(join(tmpdir(), "run-test-"));
    const oldEnv = { ...process.env };
    try {
      process.env.RUNNER_TEMP = dir;
      // Real GitHub Actions always provides this URL with an existing query
      // string (e.g. "?api-version=2.0"); @actions/core's getIDToken()
      // appends "&audience=..." assuming that, so the mock URL needs one too.
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `${baseUrl}/oidc-token?api-version=2.0`;
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "mock-request-token";
      process.env.INPUT_WORKLOAD_IDENTITY_PROVIDER =
        "projects/123/locations/global/workloadIdentityPools/p/providers/x";
      process.env.INPUT_SERVICE_ACCOUNT = "deploy@my-project.iam.gserviceaccount.com";
      process.env.INPUT_UNIVERSE = baseUrl;
      process.env.INPUT_CREATE_CREDENTIALS_FILE = "true";
      process.env.INPUT_EXPORT_ENVIRONMENT_VARIABLES = "true";
      // @actions/core requires this file to already exist (the real
      // runner always pre-creates it) -- it won't create it itself.
      process.env.GITHUB_OUTPUT = join(dir, "output.txt");
      writeFileSync(process.env.GITHUB_OUTPUT, "");

      const { run } = await import("../src/main");
      await run();

      const output = readFileSync(process.env.GITHUB_OUTPUT, "utf-8");
      const match = output.match(/auth_token<<(ghadelimiter_[a-f0-9-]+)\n(.*)\n\1/s);
      assert.ok(match, `auth_token not found in GITHUB_OUTPUT:\n${output}`);
      // Impersonation was requested (service_account given), so the final
      // token should be the *impersonated* token, not the raw federated one
      assert.ok(match![2].startsWith("mock-impersonated-token."));
    } finally {
      process.env = oldEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
