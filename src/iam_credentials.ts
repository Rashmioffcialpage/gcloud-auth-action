import { Endpoints, postJson } from "./client";

export interface GenerateAccessTokenParams {
  serviceAccount: string;
  delegates?: string[];
  scopes?: string[];
  lifetime?: number;
}

interface GenerateAccessTokenResponse {
  accessToken: string;
  expireTime?: string;
}

/**
 * Thin client around Google's real IAM Credentials API, used to impersonate
 * a service account (exchange a federated/authenticated token for an OAuth2
 * access token scoped to that service account's identity).
 */
export class IamCredentialsClient {
  constructor(
    private readonly endpoints: Endpoints,
    private readonly authToken: string,
  ) {}

  async generateAccessToken(params: GenerateAccessTokenParams): Promise<string> {
    const path =
      `${this.endpoints.iamcredentials}/projects/-/serviceAccounts/` +
      `${params.serviceAccount}:generateAccessToken`;

    const body: Record<string, unknown> = {};
    if (params.delegates?.length) body.delegates = params.delegates;
    if (params.scopes?.length) body.scope = params.scopes; // API field is singular "scope"
    if (params.lifetime) body.lifetime = `${params.lifetime}s`;

    const { statusCode, result } = await postJson<GenerateAccessTokenResponse>(path, body, {
      Authorization: `Bearer ${this.authToken}`,
    });

    if (statusCode < 200 || statusCode > 299) {
      throw new Error(
        `generateAccessToken for ${params.serviceAccount} failed: HTTP ${statusCode}: ${JSON.stringify(result)}`,
      );
    }
    if (!("accessToken" in result)) {
      throw new Error(`generateAccessToken succeeded but returned no accessToken`);
    }
    return result.accessToken;
  }
}
