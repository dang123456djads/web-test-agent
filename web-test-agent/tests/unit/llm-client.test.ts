/**
 * M2 Unit Tests – LLM Client (Anthropic Abstraction)
 *
 * Mocked unit tests for AnthropicClient without calling real Anthropic API.
 * Validates:
 * 1. Missing API key handling
 * 2. Successful completion and response normalization
 * 3. Token usage calculation
 * 4. Error translation (rate limit, timeout, API error, malformed response)
 * 5. Multi-turn message handling
 */

import { AnthropicClient } from '../../src/llm/anthropic-client';
import {
  APIKeyMissingError,
  LLMError,
  LLMTimeoutError,
  RateLimitError,
} from '../../src/llm/types';

// ─── Mock Anthropic SDK ────────────────────────────────────────
const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => {
    return {
      messages: {
        create: mockCreate,
      },
    };
  });
});

describe('M2 Unit: AnthropicClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('API Key handling', () => {
    it('should throw APIKeyMissingError when no API key is provided', async () => {
      const client = new AnthropicClient({ apiKey: '' });
      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(APIKeyMissingError);
    });

    it('should throw APIKeyMissingError when environment variable is empty', async () => {
      process.env['ANTHROPIC_API_KEY'] = '   ';
      const client = new AnthropicClient();
      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(APIKeyMissingError);
    });

    it('should accept API key from environment variable', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key-123';
      mockCreate.mockResolvedValueOnce({
        id: 'msg_1',
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from env key' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const client = new AnthropicClient();
      const response = await client.complete({ userPrompt: 'Hello' });
      expect(response.content).toBe('Hello from env key');
    });

    it('should prioritize explicit apiKey over environment variable', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';
      mockCreate.mockResolvedValueOnce({
        id: 'msg_2',
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Explicit key response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const client = new AnthropicClient({ apiKey: 'sk-ant-explicit-key' });
      const response = await client.complete({ userPrompt: 'Hello' });
      expect(response.content).toBe('Explicit key response');
    });
  });

  describe('Request and Response normalization', () => {
    it('should successfully complete a simple prompt and normalize response', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      mockCreate.mockResolvedValueOnce({
        id: 'msg_3',
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          { type: 'text', text: 'First line. ' },
          { type: 'text', text: 'Second line.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 25 },
      });

      const response = await client.complete({
        systemPrompt: 'You are a test assistant.',
        userPrompt: 'Generate a plan',
        temperature: 0.2,
        maxTokens: 1000,
      });

      expect(response.content).toBe('First line. Second line.');
      expect(response.model).toBe('claude-3-5-sonnet-20241022');
      expect(response.stopReason).toBe('end_turn');
      expect(response.usage).toEqual({
        inputTokens: 15,
        outputTokens: 25,
        totalTokens: 40,
      });

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        temperature: 0.2,
        system: 'You are a test assistant.',
        messages: [{ role: 'user', content: 'Generate a plan' }],
      });
    });

    it('should support multi-turn messages array', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      mockCreate.mockResolvedValueOnce({
        id: 'msg_4',
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Turn 3 reply' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 10 },
      });

      const response = await client.complete({
        userPrompt: 'fallback prompt ignored if messages provided',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'What next?' },
        ],
      });

      expect(response.content).toBe('Turn 3 reply');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'What next?' },
          ],
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should translate 429 status code to RateLimitError', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const apiError: any = new Error('Rate limit exceeded');
      apiError.status = 429;
      mockCreate.mockRejectedValueOnce(apiError);

      await expect(client.complete({ userPrompt: 'Hi' })).rejects.toThrow(RateLimitError);
    });

    it('should translate 408 or timeout error to LLMTimeoutError', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const timeoutError: any = new Error('Request timed out after 60000ms');
      timeoutError.status = 408;
      mockCreate.mockRejectedValueOnce(timeoutError);

      await expect(client.complete({ userPrompt: 'Hi' })).rejects.toThrow(LLMTimeoutError);
    });

    it('should translate 500 server error to LLMError with status code', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      const serverError: any = new Error('Internal Server Error');
      serverError.status = 500;
      serverError.error = { type: 'api_error' };
      mockCreate.mockRejectedValue(serverError);

      await expect(client.complete({ userPrompt: 'Hi' })).rejects.toThrow(LLMError);
      try {
        await client.complete({ userPrompt: 'Hi' });
      } catch (e: any) {
        expect(e.status).toBe(500);
      }
    });

    it('should throw LLMError when response content is empty', async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });

      mockCreate.mockResolvedValue({
        id: 'msg_empty',
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [],
        stop_reason: 'stop',
        usage: { input_tokens: 5, output_tokens: 0 },
      });

      await expect(client.complete({ userPrompt: 'Hi' })).rejects.toThrow(LLMError);
      await expect(client.complete({ userPrompt: 'Hi' })).rejects.toThrow(/empty content/i);
    });
  });
});
