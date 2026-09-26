import Anthropic from '@anthropic-ai/sdk';
import { getLogger } from '../logger';
import {
  LLMClient,
  LLMClientConfig,
  LLMRequest,
  LLMResponse,
  LLMError,
  APIKeyMissingError,
  LLMTimeoutError,
  RateLimitError,
} from './types';

// ============================================================
// AnthropicClient – web-test-agent / src/llm/anthropic-client.ts
// Robust wrapper for Anthropic Messages API.
// ============================================================

const log = getLogger('anthropic-client');

const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.0;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export class AnthropicClient implements LLMClient {
  private readonly client: Anthropic | null = null;
  private readonly config: Required<LLMClientConfig>;
  private readonly apiKey: string;

  constructor(config: LLMClientConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';

    this.config = {
      apiKey: this.apiKey,
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      defaultTemperature: config.defaultTemperature ?? DEFAULT_TEMPERATURE,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    };

    if (this.apiKey.trim().length > 0) {
      this.client = new Anthropic({
        apiKey: this.apiKey,
        timeout: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
      });
    }
  }

  /**
   * Send a completion request to Anthropic Messages API.
   *
   * @throws APIKeyMissingError if API key is not configured
   * @throws LLMTimeoutError if the request times out
   * @throws RateLimitError if 429 rate limit is encountered
   * @throws LLMError on other API or parsing failures
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client || !this.apiKey.trim()) {
      log.error({ event: 'missing_api_key' }, 'Anthropic API key is missing');
      throw new APIKeyMissingError();
    }

    const model = request.model ?? this.config.defaultModel;
    const maxTokens = request.maxTokens ?? this.config.defaultMaxTokens;
    const temperature = request.temperature ?? this.config.defaultTemperature;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (request.messages && request.messages.length > 0) {
      for (const m of request.messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          messages.push({ role: m.role, content: m.content });
        }
      }
    } else {
      messages.push({ role: 'user', content: request.userPrompt });
    }

    const startTime = Date.now();
    log.info(
      {
        event: 'llm_request_start',
        model,
        max_tokens: maxTokens,
        temperature,
        system_present: Boolean(request.systemPrompt),
        messages_count: messages.length,
      },
      'Sending request to Anthropic API'
    );

    try {
      const createParams: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages,
      };

      if (request.systemPrompt) {
        createParams.system = request.systemPrompt;
      }

      const response = await this.client.messages.create(createParams);

      const durationMs = Date.now() - startTime;

      // Extract text content from content blocks
      let fullText = '';
      if (Array.isArray(response?.content)) {
        for (const block of response.content) {
          if (block.type === 'text') {
            fullText += block.text;
          }
        }
      }

      if (!fullText && (!response?.content || response.content.length === 0)) {
        throw new LLMError('Malformed response: received empty content array from API', 500, 'MALFORMED_RESPONSE');
      }

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      };

      log.info(
        {
          event: 'llm_request_success',
          model: response.model,
          duration_ms: durationMs,
          usage,
          stop_reason: response.stop_reason,
        },
        'Received response from Anthropic API'
      );

      return {
        content: fullText,
        model: response.model,
        usage,
        stopReason: response.stop_reason ?? undefined,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;

      if (err instanceof LLMError) {
        throw err;
      }

      const errorObj = err as any;
      const status = errorObj?.status;
      const errorMessage = errorObj?.message ?? String(err);

      log.error(
        {
          event: 'llm_request_error',
          duration_ms: durationMs,
          status,
          error: errorMessage,
        },
        'LLM request failed'
      );

      if (status === 429 || errorObj?.name === 'RateLimitError') {
        throw new RateLimitError(errorMessage);
      }

      if (status === 408 || errorObj?.name === 'APIConnectionTimeoutError' || errorMessage.includes('timeout')) {
        throw new LLMTimeoutError(errorMessage);
      }

      throw new LLMError(errorMessage, status, errorObj?.error?.type ?? 'API_ERROR');
    }
  }
}
