import { anthropicConfigSchema } from "../../extensions/providers/anthropic/config.schema.js";
import { cliWrapperConfigSchema } from "../../extensions/providers/cli-wrapper/config.schema.js";
import { geminiConfigSchema } from "../../extensions/providers/gemini/config.schema.js";
import { openaiCompatibleConfigSchema } from "../../extensions/providers/openai-compatible/config.schema.js";

import type { ProviderDescriptor, ProviderProtocolId } from "./types.js";
import type { ProviderContract } from "../../contracts/providers.js";

async function loadAnthropicContract(): Promise<ProviderContract<unknown>> {
  const { contract } = await import("../../extensions/providers/anthropic/index.js");
  return contract as unknown as ProviderContract<unknown>;
}

async function loadCliWrapperContract(): Promise<ProviderContract<unknown>> {
  const { contract } = await import("../../extensions/providers/cli-wrapper/index.js");
  return contract as unknown as ProviderContract<unknown>;
}

async function loadGeminiContract(): Promise<ProviderContract<unknown>> {
  const { contract } = await import("../../extensions/providers/gemini/index.js");
  return contract as unknown as ProviderContract<unknown>;
}

async function loadOpenAICompatibleContract(): Promise<ProviderContract<unknown>> {
  const { contract } = await import("../../extensions/providers/openai-compatible/index.js");
  return contract as unknown as ProviderContract<unknown>;
}

export const PROTOCOLS: Record<ProviderProtocolId, ProviderDescriptor> = {
  anthropic: {
    protocolId: "anthropic",
    label: "anthropic",
    defaultModels: ["claude-opus-4-7"],
    defaultEnvName: "ANTHROPIC_API_KEY",
    defaultBaseURL: "https://api.anthropic.com",
    configSchema: anthropicConfigSchema,
    capabilities: {
      streaming: "hard",
      toolCalling: "hard",
      structuredOutput: "preferred",
      multimodal: "preferred",
      reasoning: "preferred",
      contextWindow: "probed",
      promptCaching: "probed",
    },
    loadContract: loadAnthropicContract,
  },
  "cli-wrapper": {
    protocolId: "cli-wrapper",
    label: "cli-wrapper (local subscription/test double)",
    defaultModels: ["reference-model"],
    configSchema: cliWrapperConfigSchema,
    capabilities: {
      streaming: "hard",
      toolCalling: "absent",
      structuredOutput: "absent",
      multimodal: "absent",
      reasoning: "absent",
      contextWindow: "probed",
      promptCaching: "absent",
    },
    loadContract: loadCliWrapperContract,
  },
  gemini: {
    protocolId: "gemini",
    label: "gemini",
    defaultModels: ["gemini-2.0-flash"],
    defaultEnvName: "GEMINI_API_KEY",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    configSchema: geminiConfigSchema,
    capabilities: {
      streaming: "hard",
      toolCalling: "hard",
      structuredOutput: "preferred",
      multimodal: "hard",
      reasoning: "probed",
      contextWindow: "probed",
      promptCaching: "probed",
    },
    loadContract: loadGeminiContract,
  },
  "openai-compatible": {
    protocolId: "openai-compatible",
    label: "openai-compatible",
    defaultModels: ["gpt-4o"],
    defaultEnvName: "OPENAI_API_KEY",
    defaultBaseURL: "https://api.openai.com/v1",
    configSchema: openaiCompatibleConfigSchema,
    capabilities: {
      streaming: "hard",
      toolCalling: "hard",
      structuredOutput: "preferred",
      multimodal: "probed",
      reasoning: "probed",
      contextWindow: "probed",
      promptCaching: "probed",
    },
    loadContract: loadOpenAICompatibleContract,
  },
};
