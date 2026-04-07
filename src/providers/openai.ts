import OpenAI from "openai";
import { AIProvider, ProviderConfig, ReviewComment, sanitizeJsonResponse } from "./types";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async getReview(prompt: string): Promise<ReviewComment[] | null> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: 10000,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        ...(this.model.includes("1106") || this.model.includes("turbo")
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          {
            role: "system",
            content: prompt,
          },
        ],
      });

      const raw = response.choices[0].message?.content?.trim() || "{}";
      const res = sanitizeJsonResponse(raw);
      return JSON.parse(res).reviews;
    } catch (error) {
      console.error("OpenAI Error:", error);
      return null;
    }
  }

  async chat(prompt: string): Promise<string | null> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: 10000,
        messages: [{ role: "user", content: prompt }],
      });
      return response.choices[0].message?.content?.trim() || null;
    } catch (error) {
      console.error("OpenAI Chat Error:", error);
      return null;
    }
  }
}
