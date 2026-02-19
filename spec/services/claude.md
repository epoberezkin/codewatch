# claude.ts -- Anthropic API Wrapper

Source: [`claude.ts`](../../src/server/services/claude.ts)

## Purpose

Wraps the Anthropic SDK to provide retry-aware API calls for message creation and token counting, plus a resilient JSON parser for Claude responses.

---

## Types

### `ClaudeResponse` (lines 6-11)

```ts
export interface ClaudeResponse {
  content: string;       // concatenated text blocks from the response
  inputTokens: number;   // usage.input_tokens
  outputTokens: number;  // usage.output_tokens
  stopReason: string;    // SDK StopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'
}
```

---

## Constants & Helpers

| Name | Value | Line |
|------|-------|------|
| `MAX_RETRIES` | `5` | 15 |
| Default model | `claude-opus-4-5-20251101` | 49, 113 |
| Default `maxTokens` | `64000` | 50 |
| Default Retry-After fallback | `60` seconds | 34 |
| Rate-limit buffer | `+5` seconds added to Retry-After | 86, 135 |
| Server-error backoff | `min(10 * 2^attempt, 120)` seconds | 89, 136 |

### `sleep(ms)` (line 17)

Returns a `Promise<void>` that resolves after `ms` milliseconds.

### `getRetryAfterSeconds(err)` (lines 21-35)

Extracts the `Retry-After` header from an error object. Tries `headers.get('retry-after')` (Web API Headers) then bracket notation. Returns the parsed integer if positive, otherwise falls back to `60`.

---

## Exported Functions

### `callClaude` (lines 45-102)

```ts
export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model?: string,       // default 'claude-opus-4-5-20251101'
  maxTokens?: number,   // default 64000
): Promise<ClaudeResponse>
```

**Behavior:**

1. Creates a fresh `Anthropic` client per call with `maxRetries: 0` (SDK retries disabled).
2. Sends a single-turn message (`system` + one `user` message).
3. Concatenates all `text`-type content blocks into `ClaudeResponse.content`.
4. Returns token usage from `response.usage` and `stop_reason` (defaults to `'end_turn'` if null).

**Retry logic (lines 56-98):**

- Loop: `attempt` from `0` to `MAX_RETRIES` (6 total attempts).
- Retries on HTTP `429` (rate limit) and `5xx` (server error).
- Rate limit wait: `Retry-After` header + 5 s buffer.
- Server error wait: exponential backoff `min(10 * 2^attempt, 120)` s.
- Logs each retry to `console.log` with status, wait time, and attempt number.
- Non-retryable errors or final attempt: rethrows the original error.
- Unreachable fallback at line 101 throws `Error('Exhausted all retries calling Claude API')`.

**Security:** API key is passed per-call and never stored. [GAP] No validation that `apiKey` is non-empty before creating the client.

---

### `countTokens` (lines 109-147)

```ts
export async function countTokens(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model?: string,       // default 'claude-opus-4-5-20251101'
): Promise<number>
```

**Behavior:**

1. Calls `client.messages.countTokens()` -- Anthropic's free token-counting endpoint.
2. Returns `result.input_tokens`.

**Retry logic (lines 118-143):** Identical structure to `callClaude` -- same conditions, same backoff, same `MAX_RETRIES`. Log prefix is `[countTokens]`.

**Note from JSDoc (lines 104-107):** Intended to use a service key (`ANTHROPIC_SERVICE_KEY`), but the signature accepts `apiKey` as a plain parameter. [GAP] The comment says "service key" but the caller is responsible for passing the correct key; nothing enforces this distinction.

---

### `parseJsonResponse<T>` (lines 154-192)

```ts
export function parseJsonResponse<T>(content: string): T
```

**Behavior -- four-stage extraction:**

| Stage | Lines | Strategy |
|-------|-------|----------|
| 1 | 157-160 | Direct `JSON.parse` on trimmed input |
| 2 | 162-168 | Strip markdown code fences (` ```json ` or ` ``` `) and parse inner content |
| 3 | 170-177 | Find outermost `{ ... }` by first/last brace and parse |
| 4 | 179-186 | Find outermost `[ ... ]` by first/last bracket and parse |

If all stages fail, throws `SyntaxError` with the first 120 characters of input for debugging (line 189).

[GAP] The generic `<T>` is unchecked at runtime -- the parsed JSON is cast without schema validation. Callers must trust Claude's output shape.

[REC] Consider adding a `zod` or similar schema validator as an optional parameter to catch malformed responses early and produce actionable error messages.

---

## Retry Flow Summary

```
attempt 0 -> call API
  on 429: wait (Retry-After + 5)s
  on 5xx: wait min(10*2^0, 120) = 10s
attempt 1 -> retry
  on 429: wait (Retry-After + 5)s
  on 5xx: wait min(10*2^1, 120) = 20s
...
attempt 5 -> last retry; on failure -> throw
```

---

## Dependencies

- `@anthropic-ai/sdk` -- Anthropic TypeScript SDK (client creation, message API, token counting).
