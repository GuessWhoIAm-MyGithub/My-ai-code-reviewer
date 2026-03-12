import { GoogleGenerativeAI } from "@google/generative-ai";
import { AIProvider, ProviderConfig, ReviewComment, sanitizeJsonResponse } from "./types";

export class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    if (config.baseUrl) {
      console.warn(
        "Warning: Custom base URL is not supported for the Gemini provider and will be ignored."
      );
    }
    this.genAI = new GoogleGenerativeAI(config.apiKey);
  }

  async getReview(prompt: string): Promise<ReviewComment[] | null> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: this.model,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 700,
          responseMimeType: "application/json",
        },
      });

      const result = await model.generateContent(prompt);
      const response = result.response;
      const raw = response.text().trim() || "{}";
      const res = sanitizeJsonResponse(raw);
      return JSON.parse(res).reviews;
    } catch (error) {
      console.error("Gemini Error:", error);
      return null;
    }
  }
}
