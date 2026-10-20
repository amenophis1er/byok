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
  let json: unknown;
  try { json = JSON.parse(body); } catch { return undefined; }
  if (!json || typeof json !== 'object') return undefined;
  const top = json as Record<string, unknown>;
  const error = top['error'] && typeof top['error'] === 'object' ? (top['error'] as Record<string, unknown>) : undefined;
  const detail = top['detail'] && typeof top['detail'] === 'object' ? (top['detail'] as Record<string, unknown>) : undefined;
  for (const value of [error?.['code'], error?.['type'], error?.['status'], detail?.['code'], top['code']]) {
    const found = code(value).providerCode;
    if (found) return found;
  }
  return undefined;
}

/** The provider's request id from its headers (`request-id`, `x-request-id`), for its support. */
export function requestIdOf(headers: Headers | undefined): string | undefined {
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('cf-ray');
  return id && id.trim() ? id.trim() : undefined;
}
