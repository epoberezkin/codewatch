import Anthropic from '@anthropic-ai/sdk';

// ---------- Types ----------

export interface ClaudeResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

// ---------- Retry Config ----------

const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(err: unknown): number {
  // Try to extract Retry-After from error headers
  const headers = (err as any)?.headers;
  if (headers) {
    // SDK uses Headers object (Web API) — try .get() first, then bracket notation
    const retryAfter = typeof headers.get === 'function'
      ? headers.get('retry-after')
      : headers['retry-after'];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return 60; // default 60s if header not found
}

// ---------- API Wrapper ----------

/**
 * Call Claude API with the provided user's API key.
 * Key is never stored — only held in-memory for the duration of the audit.
 * Retries on 429 rate limit and 5xx server errors with Retry-After support.
 */
export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-opus-4-5-20251101',
  maxTokens: number = 16384,
): Promise<ClaudeResponse> {
  // Disable SDK-level retries; we handle retries ourselves to support long Retry-After waits
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
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
    } catch (err: unknown) {
      const status = (err as any)?.status;
      const isRateLimit = status === 429;
      const isServerError = status >= 500 && status < 600;

      if ((!isRateLimit && !isServerError) || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitSeconds: number;
      if (isRateLimit) {
        waitSeconds = getRetryAfterSeconds(err) + 5; // add buffer
      } else {
        // Server errors: shorter exponential backoff (10s, 20s, 40s, ...)
        waitSeconds = Math.min(10 * Math.pow(2, attempt), 120);
      }

      const waitMin = Math.round(waitSeconds / 6) / 10; // one decimal place
      console.log(
        `[Claude API] ${isRateLimit ? 'Rate limited' : `Server error (${status})`}. ` +
        `Waiting ${waitSeconds}s (~${waitMin}min) before retry ${attempt + 1}/${MAX_RETRIES}...`
      );
      await sleep(waitSeconds * 1000);
    }
  }

  throw new Error('Exhausted all retries calling Claude API');
}

/**
 * Count tokens for a message using Anthropic's free count_tokens endpoint.
 * Uses the service key (ANTHROPIC_SERVICE_KEY), not the user's key.
 */
export async function countTokens(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-opus-4-5-20251101',
): Promise<number> {
  const client = new Anthropic({ apiKey });

  const result = await client.messages.countTokens({
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return result.input_tokens;
}

/**
 * Parse JSON from Claude's response.
 * Handles: raw JSON, markdown code blocks, and text preamble before JSON.
 */
export function parseJsonResponse<T>(content: string): T {
  const text = content.trim();

  // 1. Try direct parse (response is pure JSON)
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // 2. Strip markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch { /* continue */ }
  }

  // 3. Find the outermost JSON object (handles text preamble like "Looking at the code...")
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    } catch { /* continue */ }
  }

  // 4. Find a JSON array
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.substring(firstBracket, lastBracket + 1));
    } catch { /* continue */ }
  }

  // Nothing worked — throw with context for debugging
  throw new SyntaxError(
    `Failed to extract JSON from response. Starts with: "${text.substring(0, 120)}..."`
  );
}
