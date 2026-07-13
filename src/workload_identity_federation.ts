import { writeFileSync } from "fs";
import { Endpoints, postJson } from "./client";

export interface WifClientParams {
  githubOIDCToken: string;
  githubOIDCTokenRequestURL: string;
  githubOIDCTokenRequestToken: string;
  githubOIDCTokenAudience: string;
  workloadIdentityProviderName: string;
  serviceAccount?: string;
  endpoints: Endpoints;
}

interface StsTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Exchanges the GitHub Actions OIDC token for a Google Cloud federated
 * access token via Google's real STS token-exchange contract:
 * POST {sts}/token with grantType=token-exchange, subjectToken=<GitHub JWT>.
 */
export class WorkloadIdentityFederationClient {
  private readonly params: WifClientParams;
  private readonly audience: string;

  constructor(params: WifClientParams) {
    this.params = params;
    const iamHost = new URL(params.endpoints.iam).host;
    this.audience = `//${iamHost}/${params.workloadIdentityProviderName}`;
  }

  async getToken(): Promise<string> {
    const path = `${this.params.endpoints.sts}/token`;
    const body = {
      audience: this.audience,
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      scope: `${this.params.endpoints.www}/auth/cloud-platform`,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: this.params.githubOIDCToken,
    };

    const { statusCode, result } = await postJson<StsTokenResponse>(path, body);
    if (statusCode < 200 || statusCode > 299) {
      throw new Error(`STS token exchange failed: HTTP ${statusCode}: ${JSON.stringify(result)}`);
    }
    if (!("access_token" in result)) {
      throw new Error(`STS token exchange succeeded but returned no access_token`);
    }
    return result.access_token;
  }

  /**
   * Writes a Workload Identity Federation credential config file in the
   * exact format `gcloud`/client libraries expect for external_account auth,
   * so the rest of the toolchain (gcloud, gsutil, bq, client libraries) can
   * pick it up via GOOGLE_APPLICATION_CREDENTIALS without any code changes.
   */
  createCredentialsFile(outputPath: string): string {
    const requestURL = new URL(this.params.githubOIDCTokenRequestURL);
    requestURL.searchParams.set("audience", this.params.githubOIDCTokenAudience);

    const data: Record<string, unknown> = {
      type: "external_account",
      audience: this.audience,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: `${this.params.endpoints.sts}/token`,
      credential_source: {
        url: requestURL.toString(),
        headers: { Authorization: `Bearer ${this.params.githubOIDCTokenRequestToken}` },
        format: { type: "json", subject_token_field_name: "value" },
      },
    };

    if (this.params.serviceAccount) {
      data.service_account_impersonation_url =
        `${this.params.endpoints.iamcredentials}/projects/-/serviceAccounts/` +
        `${this.params.serviceAccount}:generateAccessToken`;
    }

    writeFileSync(outputPath, JSON.stringify(data, null, 2));
    return outputPath;
  }
}
