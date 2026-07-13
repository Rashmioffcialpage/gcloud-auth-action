# gcloud-auth-action

A GitHub Action for authenticating to Google Cloud from a workflow, via
either Workload Identity Federation (OIDC, no long-lived credentials) or
a service account key JSON.

Inspired by [google-github-actions/auth](https://github.com/google-github-actions/auth)
(via [simonw/auth](https://github.com/simonw/auth), an unmodified fork of
it — see [DESIGN.md](DESIGN.md) for why this project reproduces Google's
action rather than something Simon Willison actually wrote, and what's
scoped down from the real thing).

## Usage

```yaml
permissions:
  contents: 'read'
  id-token: 'write'

steps:
  - uses: actions/checkout@v4
  - uses: Rashmioffcialpage/gcloud-auth-action@main
    with:
      workload_identity_provider: 'projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider'
      service_account: 'deploy@my-project.iam.gserviceaccount.com'
```

## Verified without a real Google Cloud project

This is security-critical credential-exchange infrastructure — the real
action's whole job is negotiating with Google's actual STS and IAM
Credentials APIs. I don't have a real GCP project or Workload Identity
Pool to test against, so verification happens in two layers instead,
each proving a different part of the real chain:

**1. The full OIDC → STS → IAM impersonation chain, against a local mock
server implementing Google's real, documented API contracts** (request
validation, response shapes) — reusing the action's own real `universe`
input (Google's actual "universe domain" parameterization, meant for
sovereign-cloud deployments) to point at the mock instead of
`googleapis.com`. 13/13 tests pass (`npm test`), including one that runs
the *entire* `main.ts` orchestration locally: fetches a (mocked) GitHub
OIDC token, exchanges it for a federated token via the mock STS endpoint,
impersonates a service account via the mock IAM Credentials endpoint, and
writes a real `external_account` credentials file — all assertions check
what the mock *actually received*, not canned responses.

**2. A real GitHub OIDC token, fetched for real, in a real GitHub Actions
run** — `.github/workflows/verify-oidc.yml` calls `@actions/core.getIDToken()`
for real (no mocking possible here — there's no way to fake being inside
a GitHub Actions runner from a local machine) and decodes the resulting
JWT to confirm a real, correctly-shaped token: issuer
`https://token.actions.githubusercontent.com`, correct audience, real
`repository`/`ref` claims. This stops short of an actual Google STS
exchange, which needs a real GCP project.

## Two real things this testing surfaced

While building the fully-local test in layer 1, `@actions/core`'s
`getIDToken()` failed against my mock with "Response json body do not
have ID Token field" — turned out it builds the request URL as
`${requestUrl}&audience=...`, silently assuming `requestUrl` already has
a `?query` in it (true for the real GitHub Actions runtime URL, which
always includes `?api-version=2.0`, but not true for the bare mock URL I
first used). Fixed by giving the mock URL a query string too, matching
the real runtime's actual shape — a genuine detail about the real
library's behavior, not a bug in this project's code.

Separately, `core.setOutput()` failed with "Missing file at path" until
the test explicitly pre-created the `GITHUB_OUTPUT` file — the real
runner always pre-creates this file before a job starts; `@actions/core`
assumes it, rather than creating it itself.

## Design

See [DESIGN.md](DESIGN.md) for what's implemented vs. scoped out (the
service-account-key JWT-bearer exchange, domain-wide delegation, ID token
generation) and why.
