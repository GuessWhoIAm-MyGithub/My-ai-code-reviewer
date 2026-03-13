import Anthropic from "@anthropic-ai/sdk";
import { AIProvider, ProviderConfig, ReviewComment, sanitizeJsonResponse } from "./types";

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async getReview(prompt: string): Promise<ReviewComment[] | null> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const textBlock = response.content.find(
        (block) => block.type === "text"
      );
      if (!textBlock || textBlock.type !== "text") {
        return null;
      }
      const raw = textBlock.text.trim() || "{}";
      const res = sanitizeJsonResponse(raw);
      return JSON.parse(res).reviews;
    } catch (error) {
      console.error("Anthropic Error:", error);
      return null;
    }
  }
}
