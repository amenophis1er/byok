/**
 * What is known about a model before asking it: the input it accepts
 * (`contextWindow`), the output it may give (`maxOutputTokens`) and what it
 * takes (`capabilities`), so a caller can keep a transcript under the limit
 * or leave a PDF out instead of learning from a 400 after the data went.
 *
 * Providers whose listing says so (Gemini's `models.list`, OpenRouter's and
 * vLLM's `/models`, Workers AI's search) are read in `listModels()`. Anthropic's
 * and OpenAI's listings say nothing, so their families are tabled here, as
 * published at this release; a model that is not in the table carries only
 * what is certain (every Claude takes tools, images and PDFs). Each field is
 * absent when not known, never guessed.
 */

import type { ModelCapabilities, ModelInfo } from '../types.js';
import type { Connection } from './connection.js';

/** The fields of a `ModelInfo` beyond its id and name. */
export type ModelFacts = Omit<ModelInfo, 'id' | 'name'>;

const ALL: ModelCapabilities = { tools: true, images: true, pdf: true };
const TEXT_TOOLS: ModelCapabilities = { tools: true, images: false, pdf: false };

type Rule = [pattern: RegExp, facts: ModelFacts];

/** Anthropic's families: a 200k window; the output cap grew with each generation. */
const CLAUDE: Rule[] = [
  [/^claude-opus-4(?:-[01])?(?:-\d{8})?$/, { contextWindow: 200_000, maxOutputTokens: 32_000, capabilities: ALL }],
  [/^claude-opus-4(?:-|\.|$)/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL }],
  [/^claude-(?:sonnet|haiku)-4(?:-|\.|$)/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL }],
  [/^claude-3-7-sonnet/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL }],
  [/^claude-3-5-/, { contextWindow: 200_000, maxOutputTokens: 8192, capabilities: ALL }],
  [/^claude-3-(?:opus|sonnet|haiku)/, { contextWindow: 200_000, maxOutputTokens: 4096, capabilities: { tools: true, images: true, pdf: false } }],
  [/^claude-/, { capabilities: ALL }],
];

/** OpenAI's families, the Codex catalog's slugs included (`gpt-5.x-…`). */
const GPT: Rule[] = [
  [/^gpt-5/, { contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL }],
  [/^gpt-4\.1/, { contextWindow: 1_047_576, maxOutputTokens: 32_768, capabilities: ALL }],
  [/^(?:gpt-4o|chatgpt-4o)/, { contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: ALL }],
  [/^o1-mini/, { contextWindow: 128_000, maxOutputTokens: 65_536, capabilities: { tools: false, images: false, pdf: false } }],
  [/^o1-preview/, { contextWindow: 128_000, maxOutputTokens: 32_768, capabilities: { tools: false, images: false, pdf: false } }],
  [/^o3-mini/, { contextWindow: 200_000, maxOutputTokens: 100_000, capabilities: TEXT_TOOLS }],
  [/^o[134](?:-|$)/, { contextWindow: 200_000, maxOutputTokens: 100_000, capabilities: ALL }],
  [/^gpt-4-turbo/, { contextWindow: 128_000, maxOutputTokens: 4096, capabilities: { tools: true, images: true, pdf: false } }],
  [/^gpt-4(?:-|$)/, { contextWindow: 8192, maxOutputTokens: 8192, capabilities: TEXT_TOOLS }],
  [/^gpt-3\.5-turbo/, { contextWindow: 16_385, maxOutputTokens: 4096, capabilities: TEXT_TOOLS }],
];

const first = (rules: Rule[], id: string): ModelFacts => rules.find(([pattern]) => pattern.test(id))?.[1] ?? {};

const hostOf = (baseUrl: string): string => {
  try { return new URL(baseUrl).hostname; } catch { return ''; }
};

/**
 * What the tables say about `id` on this connection: Anthropic's for an
 * Anthropic connection, OpenAI's for ChatGPT and api.openai.com, both by id
 * for an OpenCode sign-in (which serves each lab's models under their own
 * ids). Nothing for other servers: their listing is the source, or nothing.
 */
export function knownModelInfo(conn: Pick<Connection, 'kind' | 'baseUrl' | 'issuer'>, id: string): ModelFacts {
  if (conn.kind === 'anthropic') return first(CLAUDE, id);
  if (conn.kind === 'chatgpt') return first(GPT, id);
  if (conn.kind === 'openai-compatible') {
    if (conn.issuer === 'opencode') return /^claude-/.test(id) ? first(CLAUDE, id) : first(GPT, id);
    if (hostOf(conn.baseUrl) === 'api.openai.com') return first(GPT, id);
  }
  return {};
}

/**
 * Gemini's `models.list` entry: its token limits, and what the family takes.
 * A Gemini model takes tools, images and PDFs; Gemma and the image, speech
 * and live models take no tools or PDFs, and whether they take images is
 * theirs to say (so it is not said).
 */
export function geminiFacts(id: string, m: { inputTokenLimit?: unknown; outputTokenLimit?: unknown }): ModelFacts {
  const gemini = /^gemini-/.test(id) && !/image|tts|audio|live/i.test(id);
  return {
    ...count('contextWindow', m.inputTokenLimit),
    ...count('maxOutputTokens', m.outputTokenLimit),
    capabilities: gemini ? ALL : { tools: false, pdf: false },
  };
}

/**
 * An OpenAI-style `/models` entry that says more than its id: OpenRouter's
 * `context_length`, `top_provider.max_completion_tokens`,
 * `architecture.input_modalities` and `supported_parameters`; vLLM's
 * `max_model_len`. Nothing for a bare `{ id }`.
 */
export function openaiListingFacts(m: Record<string, unknown>): ModelFacts {
  const top = m['top_provider'];
  const architecture = m['architecture'];
  const modalities = architecture && typeof architecture === 'object' ? (architecture as Record<string, unknown>)['input_modalities'] : undefined;
  const parameters = m['supported_parameters'];
  const capabilities: Partial<ModelCapabilities> = {};
  if (Array.isArray(modalities)) {
    capabilities.images = modalities.includes('image');
    capabilities.pdf = modalities.includes('file');
  }
  if (Array.isArray(parameters)) capabilities.tools = parameters.includes('tools');
  return {
    ...count('contextWindow', m['context_length'] ?? m['max_model_len']),
    ...count('maxOutputTokens', top && typeof top === 'object' ? (top as Record<string, unknown>)['max_completion_tokens'] : undefined),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

/** A Workers AI model's `properties` (`context_window`, `max_output_tokens`, `function_calling`), when listed. */
export function workersAiFacts(properties: unknown): ModelFacts {
  if (!Array.isArray(properties)) return {};
  const value = (name: string): unknown => {
    const entry = properties.find((p) => p && typeof p === 'object' && (p as Record<string, unknown>)['property_id'] === name) as Record<string, unknown> | undefined;
    return entry?.['value'];
  };
  const calling = value('function_calling');
  return {
    ...count('contextWindow', value('context_window')),
    ...count('maxOutputTokens', value('max_output_tokens')),
    ...(calling !== undefined ? { capabilities: { tools: calling === true || calling === 'true' } } : {}),
  };
}

/** `{ [key]: n }` for a positive count given as a number or a numeric string, else nothing. */
function count(key: 'contextWindow' | 'maxOutputTokens', value: unknown): Partial<Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'>> {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? { [key]: Math.floor(n) } : {};
}
