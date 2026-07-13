/**
 * Run only inside a real GitHub Actions job (see .github/workflows/verify-oidc.yml).
 * Fetches a REAL OIDC token from GitHub's real token endpoint -- proving
 * that specific integration point for real, since it can't be tested from
 * a local machine at all (there's no GITHUB_ACTIONS runtime to fetch from).
 * Stops short of a real Google Cloud STS exchange, which needs a real GCP
 * project this build has no access to -- see DESIGN.md.
 */
import * as core from "@actions/core";

async function main() {
  const audience = "https://iam.googleapis.com/projects/000/locations/global/workloadIdentityPools/test/providers/test";
  const token = await core.getIDToken(audience);

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error(`Expected a real JWT (3 dot-separated parts), got ${parts.length} parts`);
  }

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));

  core.info(`Real GitHub OIDC token fetched successfully.`);
  core.info(`Header alg: ${header.alg}`);
  core.info(`Issuer: ${payload.iss}`);
  core.info(`Audience: ${payload.aud}`);
  core.info(`Subject: ${payload.sub}`);
  core.info(`Repository: ${payload.repository}`);
  core.info(`Ref: ${payload.ref}`);

  if (payload.iss !== "https://token.actions.githubusercontent.com") {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }
  if (payload.aud !== audience) {
    throw new Error(`Audience mismatch: requested ${audience}, got ${payload.aud}`);
  }

  core.info("All real-OIDC-token assertions passed.");
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
