/**
 * A failure as data, beside the sentence: what kind it was, the provider's
 * own code and request id when it gave them, and whether anything had
 * streamed to the caller before it. `chat()` fills `kind` and `streamed`; the
 * protocol modules and the HTTP layer give what they know.
 */

import type { AIChatResult, AIFailure } from '../types.js';

/** A failed result from inside a stream: the kind is `stream`, with the provider's code when the event carried one. */
export function streamFailure(error: string, providerCode?: unknown): AIChatResult {
  return { ok: false, error, failure: { kind: 'stream', streamed: false, ...code(providerCode) } };
}

/** `{ providerCode }` for a code-shaped string, else nothing. */
export function code(value: unknown): Pick<AIFailure, 'providerCode'> {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? { providerCode: value } : {};
}

/**
 * The provider's own code in a failed body: OpenAI's `error.code` or
 * `error.type`, Anthropic's `error.type`, Gemini's `error.status`, ChatGPT's
 * `error.type`/`code`, a top-level `code`. Nothing when there is none.
 */
export function providerCodeOf(body: string): string | undefined {
  return providerDetailsOf(body).providerCode;
}

/** The longest provider message kept, as it was written. */
const MESSAGE_MAX = 2000;

/**
 * What a failed body says of itself: the code (`providerCodeOf`), the
 * `error.type` when it is a code-shaped string that the code did not come
 * from, and the message (`error.message`, a string `error`, `message`,
 * `detail`), cut to 2000 characters. Each only when there.
 */
export function providerDetailsOf(body: string): Pick<AIFailure, 'providerCode' | 'providerType' | 'providerMessage'> {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return {}; }
  // A body wrapped in an array (Gemini, at times): its first object.
  if (Array.isArray(json)) json = json.find((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (!json || typeof json !== 'object') return {};
  const top = json as Record<string, unknown>;
  const error = top['error'] && typeof top['error'] === 'object' ? (top['error'] as Record<string, unknown>) : undefined;
  const detail = top['detail'] && typeof top['detail'] === 'object' ? (top['detail'] as Record<string, unknown>) : undefined;
  const out: Pick<AIFailure, 'providerCode' | 'providerType' | 'providerMessage'> = {};
  for (const value of [error?.['code'], error?.['type'], error?.['status'], detail?.['code'], top['code']]) {
    const found = code(value).providerCode;
    if (found) { out.providerCode = found; break; }
  }
  const type = code(error?.['type']).providerCode;
  if (type && type !== out.providerCode) out.providerType = type;
  const message = typeof top['error'] === 'string' ? top['error'] : error?.['message'] ?? top['message'] ?? top['detail'];
  if (typeof message === 'string' && message.trim()) out.providerMessage = message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX)}…` : message;
  return out;
}

/** The provider's request id from its headers (`request-id`, `x-request-id`), for its support. */
export function requestIdOf(headers: Headers | undefined): string | undefined {
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('cf-ray');
  return id && id.trim() ? id.trim() : undefined;
}
