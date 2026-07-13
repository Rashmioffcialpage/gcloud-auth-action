/**
 * A mock server implementing the real shape of Google's STS token-exchange
 * endpoint (POST {base}/sts/v1/token) and IAM Credentials generateAccessToken
 * endpoint (POST {base}/iamcredentials/v1/projects/-/serviceAccounts/{email}:generateAccessToken).
 *
 * Used to verify this action's HTTP layer end-to-end without a real Google
 * Cloud project -- by pointing the `universe` input at this server's base
 * URL, reusing the action's real (Google-documented) universe-domain
 * parameterization point rather than a special test-only code path.
 *
 * Validates requests and echoes back what it received, so test assertions
 * are really assertions about what the *client* sent, not canned responses.
 */

import * as http from "http";

export function createMockServer(): http.Server {
  return http.createServer(handleRequest);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost`);

  // Simulates GitHub's own OIDC token endpoint (the one @actions/core's
  // getIDToken() calls) -- lets main.ts's full run() be tested locally
  // without a real GitHub Actions runner.
  if (req.method === "GET" && url.pathname === "/oidc-token") {
    const auth = req.headers["authorization"];
    if (auth !== "Bearer mock-request-token") {
      return sendJson(res, 401, { error: "invalid ACTIONS_ID_TOKEN_REQUEST_TOKEN" });
    }
    const audience = url.searchParams.get("audience") || "";
    const fakeJwt = Buffer.from(JSON.stringify({ aud: audience, sub: "repo:test/test" })).toString(
      "base64url",
    );
    return sendJson(res, 200, { value: `mock-github-oidc-token.${fakeJwt}` });
  }

  if (req.method === "POST" && url.pathname === "/sts/v1/token") {
    const body = await readBody(req);
    for (const field of ["audience", "grantType", "subjectToken", "subjectTokenType"]) {
      if (!(field in body)) {
        return sendJson(res, 400, { error: `missing field ${field}` });
      }
    }
    if (body.grantType !== "urn:ietf:params:oauth:grant-type:token-exchange") {
      return sendJson(res, 400, { error: "unsupported grantType" });
    }
    // Echo the subject token and audience back inside a fake access token
    // (base64 of a small JSON descriptor) so tests can assert on exactly
    // what was sent, without needing to actually validate a real JWT.
    const descriptor = Buffer.from(
      JSON.stringify({ audience: body.audience, subject: body.subjectToken }),
    ).toString("base64url");
    return sendJson(res, 200, {
      access_token: `mock-federated-token.${descriptor}`,
      token_type: "Bearer",
      expires_in: 3600,
    });
  }

  const impersonationMatch = url.pathname.match(
    /^\/iamcredentials\/v1\/projects\/-\/serviceAccounts\/([^:]+):generateAccessToken$/,
  );
  if (req.method === "POST" && impersonationMatch) {
    const serviceAccount = decodeURIComponent(impersonationMatch[1]);
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer mock-federated-token.")) {
      return sendJson(res, 401, { error: "missing or invalid Authorization bearer token" });
    }
    const body = await readBody(req);
    const descriptor = Buffer.from(
      JSON.stringify({ serviceAccount, scope: body.scope, delegates: body.delegates }),
    ).toString("base64url");
    return sendJson(res, 200, {
      accessToken: `mock-impersonated-token.${descriptor}`,
      expireTime: new Date(Date.now() + 3600_000).toISOString(),
    });
  }

  sendJson(res, 404, { error: `no mock handler for ${req.method} ${url.pathname}` });
}

if (require.main === module) {
  const PORT = Number(process.env.MOCK_PORT || 5401);
  createMockServer().listen(PORT, () => {
    console.log(`mock STS/IAM Credentials server listening on http://127.0.0.1:${PORT}`);
  });
}
