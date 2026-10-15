/**
 * Gemini mapping: the request body, and the turn rebuilt from the
 * streamGenerateContent SSE chunks.
 */
import { describe, expect, it } from 'vitest';
import { geminiBody, geminiContents, geminiResult } from '../src/background/chat-gemini.js';
import { readSse } from '../src/background/sse.js';
import type { AIChatRequest, AIMessage } from '../src/types.js';
import { openaiSse, streamOf } from './helpers.js';

const TOOL = { name: 'browser', description: 'Control a page.', inputSchema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string' } } } };
const parse = (chunks: Array<Record<string, unknown>>, size = 9) => geminiResult(readSse(streamOf(openaiSse(chunks, false), size)));
const chunk = (parts: Array<Record<string, unknown>>, finishReason?: string, usageMetadata?: Record<string, unknown>) =>
  ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) });

describe('request body', () => {
  const req: AIChatRequest = { system: 'You drive a browser.', messages: [{ role: 'user', content: 'Open example.com' }], tools: [TOOL] };

  it('sends the system instruction, the tools with their JSON Schema, and the output cap', () => {
    expect(geminiBody(req)).toEqual({
      systemInstruction: { parts: [{ text: 'You drive a browser.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Open example.com' }] }],
      tools: [{ functionDeclarations: [{ name: 'browser', description: 'Control a page.', parametersJsonSchema: TOOL.inputSchema }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { maxOutputTokens: 16000 },
    });
    expect(geminiBody({ system: '', messages: [], maxTokens: 500 })).toEqual({ contents: [], generationConfig: { maxOutputTokens: 500 } });
  });

  it('replays the model turn as sent, and answers its calls in one user turn, results parsed when they are objects', () => {
    const parts = [{ text: 'Looking.' }, { functionCall: { name: 'browser', args: { action: 'observe' } }, thoughtSignature: 'sig' }, { functionCall: { name: 'browser', args: { action: 'click' } } }];
    const messages: AIMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'call_0', name: 'browser', args: { action: 'observe' } }, { id: 'call_1', name: 'browser', args: { action: 'click' } }], providerState: parts },
      { role: 'tool', toolCallId: 'call_0', name: 'browser', content: '{"title":"Example"}' },
      { role: 'tool', toolCallId: 'call_1', name: 'browser', content: [{ type: 'text', text: 'clicked' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      { role: 'tool', toolCallId: 'call_2', name: 'browser', content: 'boom', isError: true },
    ];
    expect(geminiContents(messages)).toEqual([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts },
      { role: 'user', parts: [
        { functionResponse: { name: 'browser', response: { title: 'Example' } } },
        { functionResponse: { name: 'browser', response: { result: 'clicked' } } },
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        { functionResponse: { name: 'browser', response: { error: 'boom' } } },
      ] },
    ]);
  });

  it('rebuilds a model turn that has no provider state, and sends documents as inline data', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read this.' }, { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'a.pdf' }] },
      { role: 'assistant', content: 'Sure.', toolCalls: [{ id: 'c1', name: 'browser', args: { action: 'observe' } }] },
    ];
    expect(geminiContents(messages)).toEqual([
      { role: 'user', parts: [{ text: 'Read this.' }, { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } }] },
      { role: 'model', parts: [{ text: 'Sure.' }, { functionCall: { name: 'browser', args: { action: 'observe' } } }] },
    ]);
  });
});

describe('stream', () => {
  it('joins the text, hands out the calls with ids, and returns the parts with their signatures', async () => {
    const result = await parse([
      chunk([{ text: 'Let me ' }]),
      chunk([{ text: 'look.' }]),
      chunk([{ functionCall: { name: 'browser', args: { action: 'observe' } }, thoughtSignature: 'sig-1' }]),
      chunk([{ functionCall: { id: 'fc-9', name: 'browser', args: { action: 'click' } } }], 'STOP', { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10, cachedContentTokenCount: 100 }),
    ]);
    expect(result).toEqual({
      ok: true,
      text: 'Let me look.',
      toolCalls: [{ id: 'call_0', name: 'browser', args: { action: 'observe' } }, { id: 'fc-9', name: 'browser', args: { action: 'click' } }],
      providerState: [
        { text: 'Let me look.' },
        { functionCall: { name: 'browser', args: { action: 'observe' } }, thoughtSignature: 'sig-1' },
        { functionCall: { id: 'fc-9', name: 'browser', args: { action: 'click' } } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 100 },
    });
  });

  it('leaves thought summaries out of the text and the replay, unless one carries a signature', async () => {
    const result = await parse([
      chunk([{ text: 'Thinking…', thought: true }, { text: 'Hello', thoughtSignature: 'sig-t' }]),
      chunk([{ text: ' there.' }], 'STOP'),
    ]);
    expect(result).toMatchObject({ ok: true, text: 'Hello there.', stopReason: 'end' });
    expect(result.providerState).toEqual([{ text: 'Hello', thoughtSignature: 'sig-t' }, { text: ' there.' }]);
  });

  it('never hands out a call from a turn cut off by the limit or a filter', async () => {
    const cut = await parse([chunk([{ functionCall: { name: 'browser', args: {} } }], 'MAX_TOKENS')]);
    expect(cut).toEqual({ ok: true, stopReason: 'length' });
    expect(await parse([chunk([{ text: 'No.' }], 'SAFETY')])).toEqual({ ok: true, text: 'No.', stopReason: 'refusal' });
  });

  it('fails on an error chunk, a malformed call, or a stream that ends before finishing', async () => {
    expect(await parse([{ error: { code: 429, message: 'Quota exceeded.' } }])).toEqual({ ok: false, error: 'Quota exceeded.' });
    expect(await parse([chunk([], 'MALFORMED_FUNCTION_CALL')])).toEqual({ ok: false, error: 'The model made a malformed function call.' });
    expect(await parse([chunk([{ text: 'half' }])])).toEqual({ ok: false, error: 'The response stream ended before it finished.' });
  });
});
