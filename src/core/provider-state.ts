/**
 * `providerState`: what a provider needs sent back verbatim with an assistant
 * turn (Anthropic's content blocks with their thinking signatures, Gemini's
 * parts with their thought signatures, a Chat Completions call's
 * `extra_content`). Each is written tagged with the protocol that wrote it,
 * and read only under that protocol: a conversation that moved from Gemini
 * to Anthropic sends no Gemini parts as Anthropic blocks, it sends the
 * message's text and tool calls rebuilt, as a message without state would.
 *
 * State written before the tag (a bare array, a bare `{ extraContent }`) is
 * read when it looks like the protocol's own: Anthropic blocks all carry a
 * `type`, Gemini parts never do.
 */

import type { AIMessage } from '../types.js';

/** The protocol a `providerState` was written under. */
export type ProviderStateProtocol = 'anthropic' | 'gemini' | 'chat-completions' | 'responses';

type Tagged = { protocol: ProviderStateProtocol } & Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isTagged = (value: unknown): value is Tagged => isObject(value) && typeof value['protocol'] === 'string';

/** Anthropic's blocks for an assistant turn: the state written under the Messages API, else nothing. */
export function anthropicState(state: unknown): Array<Record<string, unknown>> | undefined {
  if (isTagged(state)) return state.protocol === 'anthropic' && Array.isArray(state['blocks']) ? (state['blocks'] as Array<Record<string, unknown>>) : undefined;
  // The old shape: a bare array of blocks, each with a type.
  if (Array.isArray(state) && state.every((b) => isObject(b) && typeof b['type'] === 'string')) return state as Array<Record<string, unknown>>;
  return undefined;
}

/** Gemini's parts for a model turn: the state written under the Gemini API, else nothing. */
export function geminiState(state: unknown): Array<Record<string, unknown>> | undefined {
  if (isTagged(state)) return state.protocol === 'gemini' && Array.isArray(state['parts']) ? (state['parts'] as Array<Record<string, unknown>>) : undefined;
  // The old shape: a bare array of parts, none with a type (that is a block's mark).
  if (Array.isArray(state) && state.every((p) => isObject(p) && !('type' in p))) return state as Array<Record<string, unknown>>;
  return undefined;
}

/** A Chat Completions turn's `extra_content` by call id: the state written under that protocol, else nothing. */
export function chatCompletionsState(state: unknown): Record<string, unknown> {
  if (isTagged(state)) return state.protocol === 'chat-completions' && isObject(state['extraContent']) ? state['extraContent'] : {};
  // The old shape: a bare `{ extraContent }`.
  if (isObject(state) && isObject(state['extraContent'])) return state['extraContent'];
  return {};
}

/** The Responses API's output items of a turn (reasoning with its encrypted content, messages, function calls), to send back as its input: the state written under that protocol, else nothing. */
export function responsesState(state: unknown): Array<Record<string, unknown>> | undefined {
  if (isTagged(state)) return state.protocol === 'responses' && Array.isArray(state['items']) ? (state['items'] as Array<Record<string, unknown>>) : undefined;
  return undefined;
}

/** The state as written: tagged with its protocol. */
export const tagged = {
  anthropic: (blocks: unknown[]) => ({ protocol: 'anthropic' as const, blocks }),
  gemini: (parts: unknown[]) => ({ protocol: 'gemini' as const, parts }),
  chatCompletions: (extraContent: Record<string, unknown>) => ({ protocol: 'chat-completions' as const, extraContent }),
  responses: (items: unknown[]) => ({ protocol: 'responses' as const, items }),
};

/** An Anthropic state without its thinking blocks, for a retry after the API refused them; other state untouched. */
export function withoutThinking(state: unknown): unknown {
  const blocks = anthropicState(state);
  return blocks ? tagged.anthropic(blocks.filter((b) => b['type'] !== 'thinking' && b['type'] !== 'redacted_thinking')) : state;
}

/**
 * The messages without their `providerState`, for a host moving a
 * conversation to another connection: each assistant turn is then replayed
 * from its text and tool calls. The messages themselves are not edited.
 */
export function stripProviderState<T extends AIMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !('providerState' in message)) return message;
    const { providerState: _state, ...rest } = message;
    return rest as T;
  });
}
