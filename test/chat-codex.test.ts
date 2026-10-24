import { describe, expect, it } from 'vitest';
import { codexBody, codexHttpError, codexInput, codexResult } from '../src/core/chat-codex.js';
import type { AIMessage } from '../src/types.js';
import type { SseEvent } from '../src/core/sse.js';

async function* events(...items: Array<Record<string, unknown> | string>): AsyncGenerator<SseEvent> {
  for (const item of items) yield { event: 'message', data: typeof item === 'string' ? item : JSON.stringify(item) };
}

describe('ChatGPT request', () => {
  it('maps the history to Responses items: messages, function calls and their outputs, tool images after them', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'r.pdf' }] },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'browser', args: { action: 'observe' } }, { id: 'c2', name: 'browser', argsError: { raw: '{"act', message: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'browser', content: [{ type: 'text', text: 'page' }, { type: 'image', mediaType: 'image/jpeg', data: 'SU1H' }] },
      { role: 'tool', toolCallId: 'c2', name: 'browser', content: 'invalid', isError: true },
    ];
    expect(codexInput(messages)).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read this' }, { type: 'input_file', filename: 'r.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'c1', name: 'browser', arguments: '{"action":"observe"}' },
      { type: 'function_call', call_id: 'c2', name: 'browser', arguments: '{"act' },
      { type: 'function_call_output', call_id: 'c1', output: 'page' },
      { type: 'function_call_output', call_id: 'c2', output: 'Error: invalid' },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,SU1H' }] },
    ]);
  });

  it('sends tools as functions, one call at a time by default, and never an output cap', () => {
    const body = codexBody({ system: 'Drive.', messages: [{ role: 'user', content: 'go' }], maxTokens: 8000,
      tools: [{ name: 'browser', description: 'd', inputSchema: { type: 'object' } }] }, 'gpt-5.5');
    expect(body).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, instructions: 'Drive.', tool_choice: 'auto', parallel_tool_calls: false,
      tools: [{ type: 'function', name: 'browser', description: 'd', parameters: { type: 'object' }, strict: false }] });
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('reasoning');
  });
});

describe('Responses request elsewhere', () => {
  it('sends the output cap a standard Responses endpoint takes, which the Codex backend refuses', () => {
    const req = { system: '', messages: [{ role: 'user' as const, content: 'go' }], maxTokens: 800 };
    expect(codexBody(req, 'gpt-5.5')).not.toHaveProperty('max_output_tokens');
    expect(codexBody(req, 'gpt-5.5', { maxOutputTokens: true })).toMatchObject({ max_output_tokens: 800 });
    expect(codexBody({ ...req, maxTokens: undefined }, 'gpt-5.5', { maxOutputTokens: true })).not.toHaveProperty('max_output_tokens');
  });
});

describe('ChatGPT stream', () => {
  it('assembles text and a tool call whose arguments arrive in pieces', async () => {
    const result = await codexResult(events(
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Opening ' },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'it.' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"action":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '"observe"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser', arguments: '{"action":"observe"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 9 } } },
    ));
    expect(result).toEqual({ ok: true, text: 'Opening it.', toolCalls: [{ id: 'call_1', name: 'browser', args: { action: 'observe' } }], stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 9 },
      // The turn's items, to be the next input.
      providerState: { protocol: 'responses', items: [{ type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser', arguments: '{"action":"observe"}' }] } });
  });

  it('takes whole arguments from the done item when no pieces came, and reports bad JSON as argsError', async () => {
    const result = await codexResult(events(
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'browser', arguments: '{"act' } },
      { type: 'response.completed', response: {} },
    ));
    expect(result.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'browser', argsError: { raw: '{"act' } });
  });

  it('never hands out the cut-off call from a turn cut off by the limit, and hands out the whole ones', async () => {
    const result = await codexResult(events(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'c', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"action":"na' },
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ));
    expect(result).toEqual({ ok: true, stopReason: 'length', truncatedToolCall: { id: 'c', name: 'browser', raw: '{"action":"na' } });
    // A call reported done with whole arguments was not the cut one: the limit fell in the text after it.
    const after = await codexResult(events(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'c', name: 'browser' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'c', name: 'browser', arguments: '{}' } },
      { type: 'response.output_text.delta', item_id: 'm', delta: 'and' },
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ));
    expect(after).toEqual({ ok: true, text: 'and', stopReason: 'length', toolCalls: [{ id: 'c', name: 'browser', args: {} }],
      providerState: { protocol: 'responses', items: [{ type: 'function_call', id: 'fc1', call_id: 'c', name: 'browser', arguments: '{}' }] } });
    // A whole call before the cut one is handed out, its item kept; the cut one is named and dropped from both.
    const mixed = await codexResult(events(
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'browser', arguments: '{"a":1}' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'browser' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc2', delta: '{"b' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ));
    expect(mixed).toEqual({ ok: true, stopReason: 'length', toolCalls: [{ id: 'c1', name: 'browser', args: { a: 1 } }], truncatedToolCall: { id: 'c2', name: 'browser', raw: '{"b' },
      providerState: { protocol: 'responses', items: [{ type: 'function_call', id: 'fc1', call_id: 'c1', name: 'browser', arguments: '{"a":1}' }] } });
    // An item reported done but incomplete, or done with no arguments at all, did not come whole either: held back and dropped, every one of them.
    const marked = await codexResult(events(
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'browser', arguments: '', status: 'incomplete' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc2', call_id: 'c2', name: 'browser', arguments: '{"a":1}', status: 'completed' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc3', call_id: 'c3', name: 'browser', arguments: '{"a":1}', status: 'incomplete' } },
      { type: 'response.incomplete', response: { status: 'incomplete' } },
    ));
    expect(marked).toEqual({ ok: true, stopReason: 'length', toolCalls: [{ id: 'c2', name: 'browser', args: { a: 1 } }], truncatedToolCall: { id: 'c3', name: 'browser', raw: '{"a":1}' },
      providerState: { protocol: 'responses', items: [{ type: 'function_call', id: 'fc2', call_id: 'c2', name: 'browser', arguments: '{"a":1}', status: 'completed' }] } });
    // The reason given says which: the limit, or a filter (a refusal). Unknown or absent, the limit.
    const reason = (details: Record<string, unknown> | undefined) => codexResult(events(
      { type: 'response.output_text.delta', item_id: 'm', delta: 'Part' },
      { type: 'response.incomplete', response: { status: 'incomplete', ...(details ? { incomplete_details: details } : {}) } },
    ));
    expect(await reason({ reason: 'max_output_tokens' })).toEqual({ ok: true, text: 'Part', stopReason: 'length' });
    expect(await reason({ reason: 'content_filter' })).toEqual({ ok: true, text: 'Part', stopReason: 'refusal' });
    expect(await reason({ reason: 'something_new' })).toEqual({ ok: true, text: 'Part', stopReason: 'length' });
    expect(await reason(undefined)).toEqual({ ok: true, text: 'Part', stopReason: 'length' });
  });

  it('fails on an error event, a failed response, or a stream that ends before completing', async () => {
    expect(await codexResult(events({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'secret prompt echo' } })))
      .toMatchObject({ ok: false, error: 'Your ChatGPT plan’s limit is reached. Wait for it to reset.' });
    expect((await codexResult(events({ type: 'response.failed', response: { error: { code: 'server_error' } } }))).ok).toBe(false);
    // A rate limit reported inside the stream keeps what the event says about coming back: the plan's window and its reset, nothing assumed from the code alone.
    const at = Math.floor(Date.now() / 1000) + 3600;
    const plan = await codexResult(events({ type: 'error', error: { type: 'usage_limit_reached', resets_at: at } }));
    expect(plan).toMatchObject({ ok: false, failure: { kind: 'stream', providerCode: 'usage_limit_reached' }, quota: 'plan' });
    expect(plan.resetAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(plan.retryAfterMs).toBeGreaterThan(3_500_000);
    const bare = await codexResult(events({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } } }));
    expect(bare).toMatchObject({ ok: false, failure: { kind: 'stream', providerCode: 'rate_limit_exceeded' } });
    for (const field of ['quota', 'retryAfterMs', 'resetAt', 'retryable']) expect(bare).not.toHaveProperty(field);
    const soon = await codexResult(events({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests per minute. Please try again in 20s.' } } }));
    expect(soon).toMatchObject({ quota: 'minute', retryAfterMs: 20_000 });
    // ChatGPT's words never come through, the model a quota names included; another server's do.
    const quota = { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'PerDay', quotaValue: '50', quotaDimensions: { model: 'secret prompt echo' } }] };
    const hidden = await codexResult(events({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests per day.', details: [quota] } }));
    expect(JSON.stringify(hidden)).not.toContain('secret prompt echo');
    expect(hidden).toMatchObject({ quota: 'day', limit: { value: 50 } });
    const shown = await codexResult(events({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests per day.', details: [quota] } }), (body) => body);
    expect(shown).toMatchObject({ quota: 'day', limit: { value: 50, model: 'secret prompt echo' } });
    expect(await codexResult(events({ type: 'response.output_text.delta', item_id: 'm', delta: 'half' })))
      .toMatchObject({ ok: false, error: 'The response stream ended before it finished.' });
  });
});

describe('ChatGPT errors', () => {
  it('say what happened without echoing provider text', () => {
    expect(codexHttpError(401, '{"error":{"message":"your prompt was..."}}')).toBe('ChatGPT rejected this sign-in. Sign in again in Settings.');
    expect(codexHttpError(400, '{"detail":"The \'gpt-9\' model is not supported when using Codex with a ChatGPT account."}')).toMatch(/not available for this ChatGPT account/);
    expect(codexHttpError(400, '{"error":{"code":"bad_thing","message":"leaks the request"}}')).toBe('ChatGPT refused the request (HTTP 400; bad_thing).');
    expect(codexHttpError(503, 'oops')).toBe('ChatGPT’s backend failed (HTTP 503).');
  });
});
