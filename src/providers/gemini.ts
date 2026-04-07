import { GoogleGenerativeAI } from "@google/generative-ai";
import { AIProvider, ProviderConfig, ReviewComment, sanitizeJsonResponse } from "./types";

export class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;
  private maxTokens: number;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens;
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
          maxOutputTokens: this.maxTokens,
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

  async chat(prompt: string): Promise<string | null> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: this.model,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: this.maxTokens,
        },
      });
      const result = await model.generateContent(prompt);
      return result.response.text().trim() || null;
    } catch (error) {
      console.error("Gemini Chat Error:", error);
      return null;
    }
  }
}
