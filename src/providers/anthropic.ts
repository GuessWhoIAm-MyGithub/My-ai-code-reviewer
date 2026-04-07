import Anthropic from "@anthropic-ai/sdk";
import { AIProvider, ProviderConfig, ReviewComment, sanitizeJsonResponse } from "./types";

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async getReview(prompt: string): Promise<ReviewComment[] | null> {
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      });
      const response = await stream.finalMessage();
      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") return null;
      const raw = textBlock.text.trim() || "{}";
      const res = sanitizeJsonResponse(raw);
      return JSON.parse(res).reviews;
    } catch (error) {
      console.error("Anthropic Error:", error);
      return null;
    }
  }

  async chat(prompt: string): Promise<string | null> {
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      });
      const response = await stream.finalMessage();
      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") return null;
      return textBlock.text.trim() || null;
    } catch (error) {
      console.error("Anthropic Chat Error:", error);
      return null;
    }
  }
}
