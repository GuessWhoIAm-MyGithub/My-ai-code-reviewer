import { AIProvider, ProviderConfig } from "./types";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";

export function createProvider(
  providerName: string,
  config: ProviderConfig
): AIProvider {
  switch (providerName.toLowerCase()) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    default:
      throw new Error(
        `Unsupported AI provider: "${providerName}". Supported providers: openai, anthropic, gemini`
      );
  }
}

export type { AIProvider, ProviderConfig };
