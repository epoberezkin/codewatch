import Anthropic from '@anthropic-ai/sdk';

// ---------- Types ----------

export interface ClaudeResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

// ---------- API Wrapper ----------

/**
 * Call Claude API with the provided user's API key.
 * Key is never stored — only held in-memory for the duration of the audit.
 */
export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-opus-4-5-20251101',
  maxTokens: number = 16384,
): Promise<ClaudeResponse> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textContent = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as any).text)
    .join('');

  return {
    content: textContent,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * Parse JSON from Claude's response, handling markdown code blocks.
 */
export function parseJsonResponse<T>(content: string): T {
  // Strip markdown code blocks if present
  let json = content.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(json);
}
