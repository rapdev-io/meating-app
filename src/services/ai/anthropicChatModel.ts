import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

// Anthropic's API refuses browser-origin requests unless the caller opts in
// with a "dangerous direct browser access" header, and the assistant panel's
// pill window keeps Chromium's default webSecurity enabled (unlike the
// control panel window), so that opt-in is fragile. This LanguageModelV3 shim
// keeps streamText and tool execution in the renderer while proxying
// doStream over IPC: main runs the real Anthropic provider and relays each
// stream part verbatim. Mirrors `createEnterpriseChatModel`.

// Structured-clone whitelist — abortSignal and other non-serializable call
// options must not cross the IPC boundary.
const SERIALIZABLE_OPTION_KEYS = [
  "prompt",
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "responseFormat",
  "seed",
  "tools",
  "toolChoice",
  "providerOptions",
] as const;

function pickSerializableOptions(options: LanguageModelV3CallOptions) {
  const picked: Record<string, unknown> = {};
  for (const key of SERIALIZABLE_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export function createAnthropicChatModel(modelId: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "anthropic",
    modelId,
    supportedUrls: {},

    async doGenerate() {
      throw new Error("Anthropic chat model is streaming-only; use doStream.");
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const api = window.electronAPI;
      if (!api?.anthropicStreamStart || !api.onAnthropicStreamPart) {
        throw new Error("Anthropic streaming is not available in this environment");
      }

      const streamId = crypto.randomUUID();
      let unsubscribe: (() => void) | undefined;
      const stopListening = () => {
        unsubscribe?.();
        unsubscribe = undefined;
      };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          let settled = false;
          const fail = (message: string) => {
            if (settled) return;
            settled = true;
            stopListening();
            controller.error(new Error(message));
          };

          unsubscribe = api.onAnthropicStreamPart!((payload) => {
            if (payload.streamId !== streamId) return;
            if (payload.error) {
              fail(payload.error);
            } else if (payload.done) {
              if (settled) return;
              settled = true;
              stopListening();
              controller.close();
            } else if (payload.part) {
              controller.enqueue(payload.part as LanguageModelV3StreamPart);
            }
          });

          options.abortSignal?.addEventListener("abort", () => {
            api.anthropicStreamCancel?.(streamId);
          });

          api.anthropicStreamStart!({
            streamId,
            modelId,
            options: pickSerializableOptions(options),
          })
            .then((result) => {
              if (result && !result.success) fail(result.error || "Anthropic stream failed");
            })
            .catch((error: Error) => fail(error.message));
        },
        cancel: () => {
          stopListening();
          api.anthropicStreamCancel?.(streamId);
        },
      });

      return { stream };
    },
  };
}
