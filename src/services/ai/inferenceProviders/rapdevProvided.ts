import type { InferenceProvider } from "./types";
import { getCloudModel } from "../../../models/ModelRegistry";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";

// Same Anthropic Messages API as anthropicProvider, but keyed with the
// RapDev-provided key (RAPDEV_ANTHROPIC_API_KEY, main-process only — never
// sent to the renderer) instead of a user-entered BYOK key.
export const rapdevProvidedProvider: InferenceProvider = {
  id: "rapdevProvided",
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("RapDev Provided reasoning is not available in this environment");
    }

    logger.logReasoning("RAPDEV_PROVIDED_START", { model, agentName, environment: "browser" });
    const startTime = Date.now();

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const supportsTemperature = getCloudModel(model)?.supportsTemperature ?? false;
    const result = await window.electronAPI.processRapdevReasoning(
      userContent,
      model,
      agentName,
      {
        ...config,
        systemPrompt,
        supportsTemperature,
      }
    );

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("RAPDEV_PROVIDED_ERROR", { model, processingTimeMs, error: result.error });
      throw new Error(result.error);
    }

    logger.logReasoning("RAPDEV_PROVIDED_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text.length,
    });
    return result.text;
  },
};
