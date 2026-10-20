/**
 * `providerState` is tagged with the protocol that wrote it (#36): read back
 * there, ignored elsewhere, and the old untagged shapes still read.
 */
import { describe, expect, it } from 'vitest';
import { anthropicMessages } from '../src/core/chat-anthropic.js';
import { geminiContents } from '../src/core/chat-gemini.js';
import { openaiMessages } from '../src/core/chat-openai.js';
import { stripProviderState } from '../src/core/index.js';
import type { AIMessage } from '../src/types.js';

const anthropic = { protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: 'plan', signature: 's' }, { type: 'tool_use', id: 't1', name: 'browser', input: { a: 1 } }] };
const gemini = { protocol: 'gemini', parts: [{ text: 'Looking.' }, { functionCall: { name: 'browser', args: { a: 1 } }, thoughtSignature: 'g' }] };
const chatCompletions = { protocol: 'chat-completions', extraContent: { t1: { google: { thought_signature: 'x' } } } };
const turn = (providerState: unknown): AIMessage[] => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 't1', name: 'browser', args: { a: 1 } }], providerState },
];

describe('each protocol replays only the state it wrote', () => {
  it('Anthropic: its own blocks; another protocol\'s state is rebuilt from text and calls', () => {
    expect(anthropicMessages(turn(anthropic))[1]!.content).toEqual(anthropic.blocks);
    const rebuilt = [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'browser', input: { a: 1 } }];
    expect(anthropicMessages(turn(gemini))[1]!.content).toEqual(rebuilt);
    expect(anthropicMessages(turn(chatCompletions))[1]!.content).toEqual(rebuilt);
    expect(anthropicMessages(turn(undefined))[1]!.content).toEqual(rebuilt);
  });

  it('Gemini: its own parts; another protocol\'s state is rebuilt', () => {
    expect(geminiContents(turn(gemini))[1]!.parts).toEqual(gemini.parts);
    const rebuilt = [{ text: 'Looking.' }, { functionCall: { name: 'browser', args: { a: 1 } } }];
    expect(geminiContents(turn(anthropic))[1]!.parts).toEqual(rebuilt);
    expect(geminiContents(turn(chatCompletions))[1]!.parts).toEqual(rebuilt);
  });

  it('Chat Completions: its own extra_content; another protocol\'s state adds nothing', () => {
    const calls = (state: unknown) => (openaiMessages('', turn(state))[1]!['tool_calls'] as Array<Record<string, unknown>>);
    expect(calls(chatCompletions)[0]).toMatchObject({ extra_content: chatCompletions.extraContent['t1'] });
    expect(calls(anthropic)[0]).not.toHaveProperty('extra_content');
    expect(calls(gemini)[0]).not.toHaveProperty('extra_content');
  });

  it('reads the shapes written before the tag by what they look like', () => {
    expect(anthropicMessages(turn(anthropic.blocks))[1]!.content).toEqual(anthropic.blocks);
    expect(geminiContents(turn(gemini.parts))[1]!.parts).toEqual(gemini.parts);
    // Bare Gemini parts are not Anthropic blocks (no `type`), and the reverse.
    expect(anthropicMessages(turn(gemini.parts))[1]!.content).toEqual([{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'browser', input: { a: 1 } }]);
    expect(geminiContents(turn(anthropic.blocks))[1]!.parts).toEqual([{ text: 'Looking.' }, { functionCall: { name: 'browser', args: { a: 1 } } }]);
    const calls = openaiMessages('', turn({ extraContent: chatCompletions.extraContent }))[1]!['tool_calls'] as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({ extra_content: chatCompletions.extraContent['t1'] });
    // Garbage is no state at all.
    for (const junk of [null, 7, 'x', [1, 'y'], { protocol: 'anthropic' }, { protocol: 'gemini', parts: 'no' }]) {
      expect(anthropicMessages(turn(junk))[1]!.content).toHaveLength(2);
      expect(geminiContents(turn(junk))[1]!.parts).toHaveLength(2);
    }
  });
});

describe('stripProviderState', () => {
  it('drops the state from every assistant turn and leaves the rest, without editing the input', () => {
    const messages = turn(anthropic);
    const stripped = stripProviderState(messages);
    expect(stripped[1]).toEqual({ role: 'assistant', content: 'Looking.', toolCalls: [{ id: 't1', name: 'browser', args: { a: 1 } }] });
    expect(stripped[1]).not.toHaveProperty('providerState');
    expect(stripped[0]).toBe(messages[0]);
    expect(messages[1]).toHaveProperty('providerState');
  });
});
