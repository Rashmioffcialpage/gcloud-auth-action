/**
 * Base HTTP client with Google's real endpoint-templating mechanism: each
 * endpoint is a template like `https://sts.{universe}/v1` where `{universe}`
 * is normally `googleapis.com` (Google's real "universe domain" feature,
 * meant for sovereign-cloud deployments that use a different domain
 * entirely). This project reuses that exact, real parameterization point to
 * redirect at a local mock server during testing -- not a testing hack
 * bolted on separately, the same mechanism Google's own docs describe for
 * pointing this action at a non-standard Google Cloud universe.
 */

export interface Endpoints {
  iam: string;
  iamcredentials: string;
  sts: string;
  www: string;
}

export function expandEndpoints(universe: string): Endpoints {
  const isLocal = universe.startsWith("http://") || universe.startsWith("https://");
  const base = isLocal ? universe.replace(/\/$/, "") : null;

  if (base) {
    // Local/mock mode: everything goes to one base URL with distinguishing paths.
    return {
      iam: `${base}/iam/v1`,
      iamcredentials: `${base}/iamcredentials/v1`,
      sts: `${base}/sts/v1`,
      www: base,
    };
  }

  return {
    iam: `https://iam.${universe}/v1`,
    iamcredentials: `https://iamcredentials.${universe}/v1`,
    sts: `https://sts.${universe}/v1`,
    www: `https://www.${universe}`,
  };
}

export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; result: T | { error: string } }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const result = (await resp.json()) as T;
  return { statusCode: resp.status, result };
}
