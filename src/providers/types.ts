export interface ReviewComment {
  lineNumber: string;
  reviewComment: string;
}

export interface AIProvider {
  getReview(prompt: string): Promise<ReviewComment[] | null>;
  chat(prompt: string): Promise<string | null>;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export function sanitizeJsonResponse(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return cleaned;
}
