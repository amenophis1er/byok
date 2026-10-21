/**
 * Reasoning (#35): the request setting mapped to each provider, reasoning
 * reported as it streams and on the result, inline thinking split from the
 * text, the Responses turn replayed with its encrypted reasoning, and the
 * retry without the thinking blocks Anthropic refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicBody, anthropicResult, claudeThinking, thinkingFields } from '../src/core/chat-anthropic.js';
import { codexBody, codexInput, codexResult } from '../src/core/chat-codex.js';
import { geminiBody, geminiResult, geminiThinking } from '../src/core/chat-gemini.js';
import { ThinkSplitter, lowestEffort, openaiBody, openaiResult, rejectedField } from '../src/core/chat-openai.js';
import { chat, type Connection, type Fetch } from '../src/core/index.js';
import { readSse } from '../src/core/sse.js';
import type { AIChatRequest, AIMessage } from '../src/types.js';
import type { ChatEvent } from '../src/core/events.js';
import { anthropicSse, openaiSse, streamOf } from './helpers.js';

const req: AIChatRequest = { system: '', messages: [{ role: 'user', content: 'Why?' }], tools: [] };
const sse = (text: string) => readSse(streamOf(text, 9));
const OPENAI = 'https://api.openai.com/v1';

afterEach(() => vi.unstubAllGlobals());

describe('the request, per provider', () => {
  it('Anthropic: adaptive thinking with an effort on the models that take it, a budget before them, nothing on the rest', () => {
    expect(claudeThinking('claude-sonnet-5-5')).toBe('adaptive');
    expect(claudeThinking('claude-opus-4-6')).toBe('adaptive');
    expect(claudeThinking('claude-sonnet-4-5-20250929')).toBe('enabled');
    expect(claudeThinking('claude-3-7-sonnet-latest')).toBe('enabled');
    expect(claudeThinking('claude-3-5-haiku-20241022')).toBe('none');
    expect(thinkingFields('high', 'claude-opus-5-5', 16000)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } });
    expect(thinkingFields('low', 'claude-sonnet-4-5', 16000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(thinkingFields('high', 'claude-sonnet-4-5', 16000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 14976 } });
    // The budget leaves room for the answer, and is skipped when there is none.
    expect(thinkingFields('medium', 'claude-sonnet-4-5', 4000)).toEqual({ thinking: { type: 'enabled', budget_tokens: 2976 } });
    expect(thinkingFields('medium', 'claude-sonnet-4-5', 2000)).toEqual({});
    expect(thinkingFields('medium', 'claude-3-5-sonnet', 16000)).toEqual({});
    expect(thinkingFields(undefined, 'claude-opus-5-5', 16000)).toEqual({});
  });

  it('Anthropic: off is sent only where the model thinks by default and can be told not to', () => {
    expect(thinkingFields('off', 'claude-opus-5')).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingFields('off', 'claude-haiku-5-5')).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingFields('off', 'claude-sonnet-5-5')).toEqual({ thinking: { type: 'between_tools' } });
    for (const always of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-mythos-5-1']) expect(thinkingFields('off', always), always).toEqual({});
    for (const quiet of ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-3-5-haiku']) expect(thinkingFields('off', quiet), quiet).toEqual({});
    expect(anthropicBody({ ...req, reasoning: 'medium' }, 'claude-sonnet-5-5', [])).toMatchObject({ output_config: { effort: 'medium' } });
  });

  it('Chat Completions: reasoning_effort to OpenAI, not elsewhere, and left out when refused', () => {
    expect(openaiBody({ ...req, reasoning: 'high' }, 'gpt-5', OPENAI)).toMatchObject({ reasoning_effort: 'high' });
    expect(openaiBody({ ...req, reasoning: 'high' }, 'r1', 'https://api.groq.com/openai/v1')).not.toHaveProperty('reasoning_effort');
    expect(openaiBody({ ...req, reasoning: 'high' }, 'gpt-5', OPENAI, new Set(['reasoning_effort']))).not.toHaveProperty('reasoning_effort');
    expect(rejectedField(400, '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}')).toBe('reasoning_effort');
  });

  it('Chat Completions: off sends the least effort the model takes to OpenAI, and think: false to Ollama', () => {
    expect(lowestEffort('gpt-5.1')).toBe('none');
    expect(lowestEffort('gpt-5.5-2026-04-01')).toBe('none');
    expect(lowestEffort('gpt-6')).toBe('none');
    expect(lowestEffort('gpt-5')).toBe('minimal');
    expect(lowestEffort('gpt-5-mini')).toBe('minimal');
    expect(lowestEffort('gpt-5-codex')).toBe('low');
    expect(lowestEffort('gpt-5.1-codex-max')).toBe('low');
    expect(lowestEffort('o4-mini')).toBe('low');
    expect(lowestEffort('gpt-4.1')).toBeUndefined();
    expect(lowestEffort('gpt-4o')).toBeUndefined();
    expect(lowestEffort('gpt-5-chat-latest')).toBeUndefined();
    // The Pro models take only their highest levels (GPT-5 Pro: high; GPT-5.2 Pro: medium and up): nothing is the least.
    expect(lowestEffort('gpt-5-pro')).toBeUndefined();
    expect(lowestEffort('gpt-5.2-pro')).toBeUndefined();
    expect(codexBody({ ...req, reasoning: 'off' }, 'gpt-5.2-pro')).not.toHaveProperty('reasoning');
    expect(lowestEffort('o1-mini')).toBeUndefined();
    expect(lowestEffort('o1')).toBe('low');
    expect(openaiBody({ ...req, reasoning: 'off' }, 'gpt-5', OPENAI)).toMatchObject({ reasoning_effort: 'minimal' });
    expect(openaiBody({ ...req, reasoning: 'off' }, 'gpt-5.2', OPENAI)).toMatchObject({ reasoning_effort: 'none' });
    // A model not known to reason gets nothing: the field would be refused on every turn.
    expect(openaiBody({ ...req, reasoning: 'off' }, 'gpt-4.1', OPENAI)).not.toHaveProperty('reasoning_effort');
    expect(openaiBody({ ...req, reasoning: 'off' }, 'gpt-5', OPENAI, new Set(['reasoning_effort']))).not.toHaveProperty('reasoning_effort');
    // Ollama's own switch, local or ollama.com; left out when refused, and never sent elsewhere or for a level.
    for (const base of ['http://localhost:11434/v1', 'http://192.168.1.4:11434/v1', 'https://ollama.com/v1']) {
      expect(openaiBody({ ...req, reasoning: 'off' }, 'qwen3', base), base).toMatchObject({ think: false });
      expect(openaiBody({ ...req, reasoning: 'off' }, 'qwen3', base), base).not.toHaveProperty('reasoning_effort');
    }
    expect(openaiBody({ ...req, reasoning: 'off' }, 'qwen3', 'http://localhost:11434/v1', new Set(['think']))).not.toHaveProperty('think');
    expect(openaiBody({ ...req, reasoning: 'low' }, 'qwen3', 'http://localhost:11434/v1')).not.toHaveProperty('think');
    expect(openaiBody({ ...req, reasoning: 'off' }, 'qwen3', 'https://api.groq.com/openai/v1')).not.toHaveProperty('think');
    expect(openaiBody({ ...req, reasoning: 'off' }, 'gpt-5', OPENAI)).not.toHaveProperty('think');
    expect(rejectedField(400, '{"error":{"message":"Unrecognized request argument supplied: think"}}')).toBe('think');
    expect(rejectedField(400, '{"error":{"message":"I think the model is wrong"}}')).toBe('think'); // harmless: the retry drops it only when the request carried it
  });

  it('Responses: the effort with a summary; the encrypted reasoning always asked for, since nothing is stored; off sends the least effort', () => {
    expect(codexBody({ ...req, reasoning: 'medium' }, 'gpt-5.5')).toMatchObject({ reasoning: { effort: 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'] });
    expect(codexBody({ ...req, reasoning: 'off' }, 'gpt-5.5')).toMatchObject({ reasoning: { effort: 'none' } });
    expect(codexBody({ ...req, reasoning: 'off' }, 'gpt-5')).toMatchObject({ reasoning: { effort: 'minimal' } });
    expect(codexBody({ ...req, reasoning: 'off' }, 'gpt-4.1')).not.toHaveProperty('reasoning');
    // The Codex backend's accepted levels are not published: low, which every model there takes.
    expect(codexBody({ ...req, reasoning: 'off' }, 'gpt-5.5', { codex: true })).toMatchObject({ reasoning: { effort: 'low' } });
    expect(codexBody({ ...req, reasoning: 'off' }, 'gpt-5.5', { codex: true })['reasoning']).not.toHaveProperty('summary');
    expect(codexBody(req, 'gpt-5.5')).toMatchObject({ include: ['reasoning.encrypted_content'] });
    expect(codexBody(req, 'gpt-5.5')).not.toHaveProperty('reasoning');
  });

  it('Responses: a reasoning item that came without its encrypted content is left out of the replay', () => {
    const state = { protocol: 'responses', items: [
      { id: 'rs_1', type: 'reasoning', summary: [] },
      { id: 'rs_2', type: 'reasoning', encrypted_content: 'enc', summary: [] },
      { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes.' }] },
    ] };
    const items = codexInput([{ role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Yes.', providerState: state }]).slice(1);
    expect(items.map((i) => i['id'])).toEqual(['rs_2', 'msg_1']);
  });

  it('Gemini: thinkingLevel on 3 and later, a budget before, thoughts asked for when on, nothing for another family', () => {
    expect(geminiThinking('high', 'gemini-3-pro')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(geminiThinking('off', 'gemini-3.5-flash')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(geminiThinking('low', 'gemini-2.5-flash')).toEqual({ thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } });
    expect(geminiThinking('off', 'gemini-2.5-flash')).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    // The Pro models cannot stop thinking: 2.5 Pro is sent nothing for off, 3 Pro takes LOW and HIGH only.
    expect(geminiThinking('off', 'gemini-2.5-pro')).toEqual({});
    expect(geminiThinking('medium', 'gemini-2.5-pro')).toEqual({ thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } });
    expect(geminiThinking('off', 'gemini-3-pro-preview')).toEqual({ thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(geminiThinking('medium', 'gemini-3-pro')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(geminiThinking('low', 'gemini-3-pro')).toEqual({ thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } });
    // 3.1 Pro and later take every level; off is still LOW, since a Pro cannot stop thinking.
    expect(geminiThinking('medium', 'gemini-3.1-pro-preview')).toEqual({ thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true } });
    expect(geminiThinking('off', 'gemini-3.1-pro-preview')).toEqual({ thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(geminiThinking('medium', 'gemini-3.5-flash')).toEqual({ thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true } });
    expect(geminiThinking('high', 'gemma-3-27b-it')).toEqual({});
    expect(geminiThinking(undefined, 'gemini-3-pro')).toEqual({});
    expect(geminiBody({ ...req, reasoning: 'medium' }, 'gemini-3-flash')['generationConfig']).toMatchObject({ thinkingConfig: { thinkingLevel: 'MEDIUM' } });
  });
});

describe('reasoning reported as it streams and on the result', () => {
  it('Anthropic: the summarized thinking, its tokens counted', async () => {
    const seen: ChatEvent[] = [];
    const result = await anthropicResult(sse(anthropicSse([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Consider the ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'primes.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Yes.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40, output_tokens_details: { thinking_tokens: 30 } } },
      { type: 'message_stop' },
    ])), (e) => seen.push(e));
    expect(result).toMatchObject({ ok: true, text: 'Yes.', reasoning: 'Consider the primes.', usage: { outputTokens: 40, reasoningTokens: 30 } });
    expect(seen).toEqual([{ type: 'reasoning', delta: 'Consider the ' }, { type: 'reasoning', delta: 'primes.' }, { type: 'text', delta: 'Yes.' }]);
    // An omitted display streams an empty thinking: no event, no reasoning on the result.
    const quiet = await anthropicResult(sse(anthropicSse([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ])));
    expect(quiet.reasoning).toBeUndefined();
  });

  it('Chat Completions: a reasoning field, or inline <think> tags split from the text as they stream', async () => {
    const seen: ChatEvent[] = [];
    const fielded = await openaiResult(sse(openaiSse([
      { choices: [{ index: 0, delta: { reasoning_content: 'Let me see. ' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning: 'Two primes.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'Yes.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 6 } } },
    ])), (e) => seen.push(e));
    expect(fielded).toMatchObject({ text: 'Yes.', reasoning: 'Let me see. Two primes.', usage: { reasoningTokens: 6 } });
    expect(seen.map((e) => e.type)).toEqual(['reasoning', 'reasoning', 'text']);

    const events: ChatEvent[] = [];
    const inline = await openaiResult(sse(openaiSse([
      { choices: [{ index: 0, delta: { content: 'Sure. <thi' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: 'nk>hmm, 2 <' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: ' 3</think>' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: ' Yes.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ])), (e) => events.push(e));
    expect(inline).toMatchObject({ text: 'Sure.  Yes.', reasoning: 'hmm, 2 < 3' });
    expect(events.filter((e) => e.type === 'reasoning').map((e) => (e as { delta: string }).delta).join('')).toBe('hmm, 2 < 3');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Sure.  Yes.');
  });

  it('the splitter holds a possible tag start, keeps a stray close as text, and flushes at the end', () => {
    const out: string[] = [];
    const s = new ThinkSplitter((kind, delta) => out.push(`${kind}:${delta}`));
    s.push('a <'); s.push('b </think> c <reasoning>'); s.push('deep</reas'); s.push('oning> d <'); s.end();
    expect(out.join('|')).toBe('text:a |text:<b </think>|text: c |reasoning:deep|text: d |text:<');
    // Only the tag that opened the reasoning closes it; the other tag's close inside is reasoning text.
    const mixed: string[] = [];
    const m = new ThinkSplitter((kind, delta) => mixed.push(`${kind}:${delta}`));
    m.push('<think>A</reasoning>B</think>C'); m.end();
    expect(mixed.join('|')).toBe('reasoning:A</reasoning>|reasoning:B|text:C');
  });

  it('Responses: summary deltas, the reasoning tokens, and the turn\'s items kept to replay', async () => {
    const seen: ChatEvent[] = [];
    const reasoningItem = { id: 'rs_1', type: 'reasoning', encrypted_content: 'enc…', summary: [{ type: 'summary_text', text: 'Two primes.' }] };
    const result = await codexResult(sse(openaiSse([
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Two ' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'primes.' },
      { type: 'response.reasoning_summary_text.done', item_id: 'rs_1', text: 'Two primes.' },
      { type: 'response.output_item.done', item: reasoningItem },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Yes.' },
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes.' }] } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 } } } },
    ], false)), undefined, (e) => seen.push(e));
    expect(result).toMatchObject({ text: 'Yes.', reasoning: 'Two primes.', usage: { reasoningTokens: 6 }, providerState: { protocol: 'responses', items: [reasoningItem, expect.objectContaining({ type: 'message' })] } });
    expect(seen.map((e) => e.type)).toEqual(['reasoning', 'reasoning', 'text']);
    // The items go back as the turn's input; without them the turn is rebuilt.
    const history: AIMessage[] = [{ role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Yes.', providerState: result.providerState }];
    expect(codexInput(history).slice(1)).toEqual(result.providerState && (result.providerState as { items: unknown[] }).items);
    expect(codexInput([{ role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Yes.', providerState: { protocol: 'anthropic', blocks: [] } }])[1]).toMatchObject({ type: 'message', role: 'assistant' });
  });

  it('Gemini: thought summaries as reasoning, counted', async () => {
    const seen: ChatEvent[] = [];
    const result = await geminiResult(sse(openaiSse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Two primes.', thought: true }, { text: 'Yes.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 6 } },
    ], false)), (e) => seen.push(e));
    expect(result).toMatchObject({ text: 'Yes.', reasoning: 'Two primes.', usage: { inputTokens: 5, outputTokens: 9, reasoningTokens: 6 } });
    expect(seen).toEqual([{ type: 'reasoning', delta: 'Two primes.' }, { type: 'text', delta: 'Yes.' }]);
  });
});

describe('when Anthropic refuses the thinking blocks it signed', () => {
  const conn: Connection = { kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5' };
  const history: AIMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'Done.', providerState: { protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: '…', signature: 'old' }, { type: 'text', text: 'Done.' }] } },
    { role: 'user', content: 'again' },
  ];
  const ok = () => new Response(streamOf(anthropicSse([
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Again.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]), 11), { status: 200 });

  it('sends the turn once more without them, and only once', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const refuse = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }), { status: 400 });
    const fetch = vi.fn<Fetch>(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return bodies.length === 1 ? refuse() : ok(); });
    expect(await chat(conn, 'sk', { ...req, messages: history }, { fetch })).toMatchObject({ ok: true, text: 'Again.' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bodies[0])).toContain('"thinking"');
    expect(JSON.stringify(bodies[1])).not.toContain('"type":"thinking"');
    expect((bodies[1]!['messages'] as Array<{ content: unknown[] }>)[1]!.content).toEqual([{ type: 'text', text: 'Done.' }]);
    // A second refusal is the failure it is.
    const twice = vi.fn<Fetch>(async () => refuse());
    expect(await chat(conn, 'sk', { ...req, messages: history }, { fetch: twice })).toMatchObject({ ok: false, failure: { kind: 'http', status: 400 } });
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it('strips from the turn the API named onward, keeping the earlier turns\' thinking', async () => {
    const thinking = (sig: string) => ({ protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: '…', signature: sig }, { type: 'tool_use', id: `t-${sig}`, name: 'browser', input: {} }] });
    const long: AIMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', toolCalls: [{ id: 't-one', name: 'browser', args: {} }], providerState: thinking('one') },
      { role: 'tool', toolCallId: 't-one', name: 'browser', content: 'r1' },
      { role: 'tool', toolCallId: 't-one-b', name: 'browser', content: 'r2' },
      { role: 'assistant', toolCalls: [{ id: 't-two', name: 'browser', args: {} }], providerState: thinking('two') },
      { role: 'tool', toolCallId: 't-two', name: 'browser', content: 'r3' },
      { role: 'assistant', toolCalls: [{ id: 't-three', name: 'browser', args: {} }], providerState: thinking('three') },
      { role: 'tool', toolCallId: 't-three', name: 'browser', content: 'r4' },
    ];
    // The API numbers the merged messages: user 0, assistant 1, tool results 2, assistant 3, results 4, assistant 5, results 6.
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn<Fetch>(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return bodies.length === 1
      ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }), { status: 400 })
      : ok(); });
    expect(await chat(conn, 'sk', { ...req, messages: long }, { fetch })).toMatchObject({ ok: true });
    const replayed = bodies[1]!['messages'] as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(replayed[1]!.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(replayed[3]!.content.map((b) => b.type)).toEqual(['tool_use']);
    expect(replayed[5]!.content.map((b) => b.type)).toEqual(['tool_use']);
    // "cannot be modified" is about the latest assistant turn: only that one is stripped.
    const latest: Array<Record<string, unknown>> = [];
    const modified = vi.fn<Fetch>(async (_url, init) => { latest.push(JSON.parse(init!.body as string)); return latest.length === 1
      ? new Response(JSON.stringify({ error: { message: '`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.' } }), { status: 400 }) : ok(); });
    expect(await chat(conn, 'sk', { ...req, messages: long }, { fetch: modified })).toMatchObject({ ok: true });
    const again = latest[1]!['messages'] as Array<{ content: Array<{ type: string }> }>;
    expect(again[1]!.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(again[3]!.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(again[5]!.content.map((b) => b.type)).toEqual(['tool_use']);
  });

  it('turns thinking off for the retry on a manual-mode model, whose latest turn would otherwise have to open with the block', async () => {
    const manual: Connection = { kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5' };
    const bodies: Array<Record<string, unknown>> = [];
    const refuse = () => new Response(JSON.stringify({ error: { message: '`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified' } }), { status: 400 });
    const fetch = vi.fn<Fetch>(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return bodies.length === 1 ? refuse() : ok(); });
    expect(await chat(manual, 'sk', { ...req, messages: history, reasoning: 'medium' }, { fetch })).toMatchObject({ ok: true });
    expect(bodies[0]).toHaveProperty('thinking');
    expect(bodies[1]).not.toHaveProperty('thinking');
    // An adaptive model keeps its setting.
    const adaptive: Array<Record<string, unknown>> = [];
    const f2 = vi.fn<Fetch>(async (_url, init) => { adaptive.push(JSON.parse(init!.body as string)); return adaptive.length === 1 ? refuse() : ok(); });
    expect(await chat(conn, 'sk', { ...req, messages: history, reasoning: 'medium' }, { fetch: f2 })).toMatchObject({ ok: true });
    expect(adaptive[1]).toMatchObject({ thinking: { type: 'adaptive' } });
  });

  it('sends a manual-mode turn whose latest assistant message has no thinking block to open with again, with thinking off', async () => {
    const manual: Connection = { kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5' };
    // The latest turn was written with thinking off (or by another model): no block to open with when thinking is turned on.
    const plain: AIMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Done.', providerState: { protocol: 'anthropic', blocks: [{ type: 'text', text: 'Done.' }] } },
      { role: 'user', content: 'again' },
    ];
    const refuse = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1: When `thinking` is enabled, a final `assistant` message must start with a thinking block (preceeding the lastmost set of `tool_use` and `tool_result` blocks). We recommend you include thinking blocks from previous turns.' } }), { status: 400 });
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn<Fetch>(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return bodies.length === 1 ? refuse() : ok(); });
    expect(await chat(manual, 'sk', { ...req, messages: plain, reasoning: 'medium' }, { fetch })).toMatchObject({ ok: true, text: 'Again.' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty('thinking');
    expect(bodies[1]).not.toHaveProperty('thinking');
    // Not a retry for an adaptive model, or with thinking off already: the rule is manual mode's.
    const adaptive = vi.fn<Fetch>(async () => refuse());
    expect(await chat(conn, 'sk', { ...req, messages: plain, reasoning: 'medium' }, { fetch: adaptive })).toMatchObject({ ok: false, failure: { kind: 'http', status: 400 } });
    expect(adaptive).toHaveBeenCalledTimes(1);
    const off = vi.fn<Fetch>(async () => refuse());
    expect(await chat(manual, 'sk', { ...req, messages: plain }, { fetch: off })).toMatchObject({ ok: false });
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('falls back to a turn with no thinking block anywhere when the stripped retry is refused over thinking again', async () => {
    const thinking = (sig: string) => ({ protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: '…', signature: sig }, { type: 'text', text: 'ok' }] });
    const two: AIMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'ok', providerState: thinking('one') },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'ok', providerState: thinking('two') },
      { role: 'user', content: 'c' },
    ];
    const refuse = (message: string) => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message } }), { status: 400 });
    const types = (body: Record<string, unknown>, i: number) => (body['messages'] as Array<{ content: Array<{ type: string }> }>)[i]!.content.map((b) => b.type);
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn<Fetch>(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      if (bodies.length === 1) return refuse('messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.');
      if (bodies.length === 2) return refuse('`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.');
      return ok();
    });
    expect(await chat(conn, 'sk', { ...req, messages: two, reasoning: 'medium' }, { fetch })).toMatchObject({ ok: true, text: 'Again.' });
    expect(fetch).toHaveBeenCalledTimes(3);
    // The first retry strips from the turn named; the last strips every turn.
    expect(types(bodies[1]!, 1)).toEqual(['thinking', 'text']);
    expect(types(bodies[1]!, 3)).toEqual(['text']);
    expect(types(bodies[2]!, 1)).toEqual(['text']);
    expect(types(bodies[2]!, 3)).toEqual(['text']);
    expect(bodies[2]).toMatchObject({ thinking: { type: 'adaptive' } });
    // On a manual-mode model the last request runs with thinking off as well.
    const manual: Connection = { kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5' };
    const sent: Array<Record<string, unknown>> = [];
    const f2 = vi.fn<Fetch>(async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return sent.length < 3 ? refuse('messages.3.content.0: Invalid `signature` in `thinking` block.') : ok(); });
    expect(await chat(manual, 'sk', { ...req, messages: two, reasoning: 'medium' }, { fetch: f2 })).toMatchObject({ ok: true });
    expect(sent[0]).toHaveProperty('thinking');
    expect(sent[2]).not.toHaveProperty('thinking');
    expect(types(sent[2]!, 1)).toEqual(['text']);
    // No fallback when the first retry already stripped every thinking block there was: the same request is not sent twice.
    const laterOnly: AIMessage[] = [two[0]!, { role: 'assistant', content: 'ok', providerState: { protocol: 'anthropic', blocks: [{ type: 'text', text: 'ok' }] } }, ...two.slice(2)];
    const dup = vi.fn<Fetch>(async () => refuse(dup.mock.calls.length === 1 ? 'messages.3.content.0: Invalid `signature` in `thinking` block.' : '`thinking` blocks in the latest assistant message cannot be modified.'));
    expect(await chat(conn, 'sk', { ...req, messages: laterOnly }, { fetch: dup })).toMatchObject({ ok: false });
    expect(dup).toHaveBeenCalledTimes(2);
    // A second refusal about something else is the failure it is; so is a third refusal.
    const other = vi.fn<Fetch>(async () => other.mock.calls.length === 1
      ? refuse('messages.3.content.0: Invalid `signature` in `thinking` block.') : refuse('max_tokens: must be positive'));
    expect(await chat(conn, 'sk', { ...req, messages: two }, { fetch: other })).toMatchObject({ ok: false, error: expect.stringContaining('max_tokens') });
    expect(other).toHaveBeenCalledTimes(2);
    const always = vi.fn<Fetch>(async () => refuse('messages.3.content.0: Invalid `signature` in `thinking` block.'));
    expect(await chat(conn, 'sk', { ...req, messages: two }, { fetch: always })).toMatchObject({ ok: false, failure: { kind: 'http', status: 400 } });
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('does not retry another 400, or one with no thinking to drop', async () => {
    const other = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' } }), { status: 400 }));
    expect(await chat(conn, 'sk', { ...req, messages: history }, { fetch: other })).toMatchObject({ ok: false });
    expect(other).toHaveBeenCalledTimes(1);
    // Keywords near each other are not the refusal.
    const schema = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: { message: "Invalid tool schema: property 'thinking_signature' must have a type" } }), { status: 400 }));
    expect(await chat(conn, 'sk', { ...req, messages: history }, { fetch: schema })).toMatchObject({ ok: false });
    expect(schema).toHaveBeenCalledTimes(1);
    const bare = vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: { message: 'Invalid `signature` in `thinking` block.' } }), { status: 400 }));
    expect(await chat(conn, 'sk', req, { fetch: bare })).toMatchObject({ ok: false });
    expect(bare).toHaveBeenCalledTimes(1);
  });
});
