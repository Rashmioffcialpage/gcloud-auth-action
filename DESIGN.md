# Design Doc: gcloud-auth-action

## Why this exists, given the source is an unmodified fork

`simonw/auth` is a straight fork of `google-github-actions/auth` with
zero commits on top (verified: `ahead_by: 0` against upstream) — not
something Simon Willison wrote. Rather than skip it or substitute a
different repo, the call was made to build a real, working
implementation of what that fork actually *is* (Google's Workload
Identity Federation GitHub Action), scoped and verified appropriately for
an environment with no real Google Cloud project — following the same
pattern as `llm-anthropic-clone` (also security/credential-adjacent
infrastructure verified against a local mock of a real, documented API
contract, because no real account was available to test against).

## What's real and faithful to the original

- **The actual OIDC → STS → IAM Credentials chain**: fetch a GitHub
  Actions OIDC token, exchange it for a Google Cloud federated token via
  STS token-exchange (`grantType: token-exchange`, `subjectTokenType: jwt`),
  optionally impersonate a service account via IAM Credentials
  `generateAccessToken`. Same request shapes, same field names
  (including the real API's `scope` being singular even though it takes
  an array — matched exactly, not "fixed" to `scopes`).
- **The `external_account` credentials file format** written for
  `gcloud`/`gsutil`/`bq`/client libraries to consume via
  `GOOGLE_APPLICATION_CREDENTIALS` — same `credential_source.url` +
  `format.subject_token_field_name` structure real Google Cloud client
  libraries expect.
- **The universe-domain endpoint templating** — reused, not
  reimplemented as a separate test seam, as the actual mechanism for
  redirecting at a mock server in tests.

## What was scoped out, and why

- **Service account key JWT-bearer OAuth2 exchange.** The real action's
  `credentials_json` path can both write a credentials file *and*
  exchange the key for a short-lived access token via a signed JWT
  assertion (RFC 7523). This build writes the credentials file (fully
  functional for `gcloud`/client-library use, which is the far more common
  use case) but leaves `accessToken` empty on that path rather than
  implementing JWT signing with an RSA private key — a correct
  implementation needs careful, security-sensitive crypto code that
  deserves dedicated review, not something to rush alongside everything
  else here.
- **`signJWT` / domain-wide delegation / ID-token generation.** The real
  action supports additional flows (signing arbitrary JWTs as a service
  account, Workspace domain-wide delegation, generating Google-signed ID
  tokens for calling other authenticated Cloud Run/Functions services).
  These are all real, separate capabilities layered on top of the core
  authentication flow this build focuses on.
- **Retry/backoff logic.** The real action uses
  `@google-github-actions/actions-utils`' `withRetries` around its HTTP
  calls. Not included here — acceptable for a scoped verification build,
  not acceptable to omit from anything handling real production traffic
  against Google's actual rate limits.
- **The `post.ts` cleanup step.** The real action has a post-job step
  that scrubs credentials from disk after the job completes. Not
  implemented here.

## Verification methodology, restated precisely

Three distinct claims, each verified separately, deliberately not
conflated:

1. "The request/response shapes match Google's documented STS and IAM
   Credentials APIs" — verified against a local mock implementing those
   documented shapes.
2. "The full local orchestration logic (input parsing → OIDC fetch → STS
   exchange → impersonation → credentials file → outputs/env vars) is
   wired together correctly" — verified by running the actual `main.ts`
   `run()` function with every external call redirected to local mocks.
3. "This action can fetch a real GitHub Actions OIDC token" — verified by
   actually doing so, in a real GitHub Actions run, with no mocking
   possible or attempted.

None of these three, individually or together, constitute "verified
against the real Google Cloud STS/IAM Credentials APIs" — that claim
would require a real GCP project and is not made anywhere in this repo.
