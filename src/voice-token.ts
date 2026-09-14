export type MintResult = { token: string };

export const VOICE_TOKEN_URL = "https://agents.assemblyai.com/v1/token";
const EXPIRES_SECONDS = 120;
const MAX_SESSION_SECONDS = 1800;

export type MintCategory = "upstream" | "upstream_invalid" | "network";

export class MintError extends Error {
  constructor(
    message: string,
    readonly category: MintCategory,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "MintError";
  }
}

export function makeMintToken(apiKey: string): () => Promise<MintResult> {
  return async () => {
    const u = new URL(VOICE_TOKEN_URL);
    u.searchParams.set("expires_in_seconds", String(EXPIRES_SECONDS));
    u.searchParams.set("max_session_duration_seconds", String(MAX_SESSION_SECONDS));
    let res: Response;
    try {
      res = await fetch(u, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch {
      throw new MintError("token service unreachable", "network");
    }
    if (!res.ok) {
      throw new MintError("upstream rejected token request", "upstream", res.status);
    }
    let data: { token?: unknown };
    try {
      data = (await res.json()) as { token?: unknown };
    } catch {
      throw new MintError("token service returned a non-JSON response", "upstream_invalid");
    }
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new MintError("token service returned no token", "upstream_invalid");
    }
    return { token: data.token };
  };
}

export function safeMintMessage(e: MintError): string {
  switch (e.category) {
    case "network":
      return "Voice agent service is unreachable. Check your connection and try again.";
    case "upstream_invalid":
      return "The voice agent service returned an invalid response. Please try again.";
    case "upstream":
      return "The voice agent service could not issue a token right now. Please try again shortly.";
  }
}