import { writeFileSync } from "fs";

export interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
}

/**
 * Parses (and lightly validates) a service account key JSON, whether given
 * as raw JSON or base64-encoded JSON -- both forms are accepted by the real
 * action, since GitHub secrets are sometimes stored base64-encoded to avoid
 * multi-line-secret quoting issues.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let text = raw.trim();
  if (!text.startsWith("{")) {
    text = Buffer.from(text, "base64").toString("utf-8");
  }

  let parsed: ServiceAccountKey;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`credentials_json is not valid JSON (or base64-encoded JSON): ${e}`);
  }

  for (const field of ["type", "project_id", "private_key", "client_email"] as const) {
    if (!parsed[field]) {
      throw new Error(`credentials_json is missing required field "${field}"`);
    }
  }
  if (parsed.type !== "service_account") {
    throw new Error(`credentials_json has type "${parsed.type}", expected "service_account"`);
  }

  return parsed;
}

export function writeServiceAccountKeyFile(key: ServiceAccountKey, outputPath: string): string {
  writeFileSync(outputPath, JSON.stringify(key, null, 2));
  return outputPath;
}
