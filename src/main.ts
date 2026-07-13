import * as core from "@actions/core";
import { join as pathjoin } from "path";

import { expandEndpoints } from "./client";
import { IamCredentialsClient } from "./iam_credentials";
import { parseServiceAccountKey, writeServiceAccountKeyFile } from "./service_account_key";
import { WorkloadIdentityFederationClient } from "./workload_identity_federation";

function computeServiceAccountEmail(serviceAccountInput: string, credentialsJSON: string): string | undefined {
  if (serviceAccountInput) return serviceAccountInput;
  if (credentialsJSON) {
    try {
      return parseServiceAccountKey(credentialsJSON).client_email;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseBoolean(value: string, defaultValue = true): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

export async function run(): Promise<void> {
  try {
    const workloadIdentityProvider = core.getInput("workload_identity_provider");
    const credentialsJSON = core.getInput("credentials_json");
    const serviceAccountInput = core.getInput("service_account");
    const universe = core.getInput("universe") || "googleapis.com";
    const createCredentialsFile = parseBoolean(core.getInput("create_credentials_file"), true);
    const exportEnvironmentVariables = parseBoolean(core.getInput("export_environment_variables"), true);

    const providedCount = [workloadIdentityProvider, credentialsJSON].filter(Boolean).length;
    if (providedCount !== 1) {
      throw new Error(
        'Exactly one of "workload_identity_provider" or "credentials_json" must be provided',
      );
    }

    const endpoints = expandEndpoints(universe);
    const serviceAccount = computeServiceAccountEmail(serviceAccountInput, credentialsJSON);

    let accessToken: string;
    let credentialsFilePath: string | undefined;

    if (workloadIdentityProvider) {
      const audience =
        core.getInput("audience") || `https://iam.googleapis.com/${workloadIdentityProvider}`;

      const githubOIDCTokenRequestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      const githubOIDCTokenRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      if (!githubOIDCTokenRequestURL || !githubOIDCTokenRequestToken) {
        throw new Error(
          "GitHub Actions did not inject $ACTIONS_ID_TOKEN_REQUEST_TOKEN or " +
            "$ACTIONS_ID_TOKEN_REQUEST_URL into this job -- add `permissions: id-token: write`.",
        );
      }

      const githubOIDCToken = await core.getIDToken(audience);
      core.setSecret(githubOIDCToken);

      const wifClient = new WorkloadIdentityFederationClient({
        githubOIDCToken,
        githubOIDCTokenRequestURL,
        githubOIDCTokenRequestToken,
        githubOIDCTokenAudience: audience,
        workloadIdentityProviderName: workloadIdentityProvider,
        serviceAccount,
        endpoints,
      });

      const federatedToken = await wifClient.getToken();

      if (serviceAccount) {
        const iamClient = new IamCredentialsClient(endpoints, federatedToken);
        accessToken = await iamClient.generateAccessToken({
          serviceAccount,
          scopes: [`${endpoints.www}/auth/cloud-platform`],
        });
      } else {
        accessToken = federatedToken;
      }

      if (createCredentialsFile) {
        credentialsFilePath = wifClient.createCredentialsFile(
          pathjoin(process.env.RUNNER_TEMP || ".", `gha-creds-${Date.now()}.json`),
        );
      }
    } else {
      const key = parseServiceAccountKey(credentialsJSON);
      if (createCredentialsFile) {
        credentialsFilePath = writeServiceAccountKeyFile(
          key,
          pathjoin(process.env.RUNNER_TEMP || ".", `gha-creds-${Date.now()}.json`),
        );
      }
      // Real action performs a JWT-bearer OAuth2 exchange here using the
      // private key; scoped out of this build -- see DESIGN.md.
      accessToken = "";
    }

    if (accessToken) core.setSecret(accessToken);
    core.setOutput("auth_token", accessToken);
    core.setOutput("credentials_file_path", credentialsFilePath || "");
    core.setOutput("project_id", core.getInput("project_id"));

    if (exportEnvironmentVariables && credentialsFilePath) {
      core.exportVariable("GOOGLE_APPLICATION_CREDENTIALS", credentialsFilePath);
      core.exportVariable("GOOGLE_GHA_CREDS_PATH", credentialsFilePath);
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

if (require.main === module) {
  run();
}
