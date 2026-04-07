export interface ReviewComment {
  lineNumber: string;
  reviewComment: string;
  severity: "critical" | "high" | "medium";
}

export interface AIProvider {
  getReview(prompt: string): Promise<ReviewComment[] | null>;
  chat(prompt: string): Promise<string | null>;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens: number;
}

export function sanitizeJsonResponse(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  }
  // Extract JSON object in case the model prepended preamble text
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonStart < jsonEnd) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }
  return cleaned;
}
