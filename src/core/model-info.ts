/**
 * What is known about a model before asking it: the input it accepts
 * (`contextWindow`), the output it may give (`maxOutputTokens`) and what it
 * takes (`capabilities`), so a caller can keep a transcript under the limit
 * or leave a PDF out instead of learning from a 400 after the data went.
 *
 * Providers whose listing says so (Anthropic's `/v1/models` since the 5
 * generation, Gemini's `models.list`, OpenRouter's and vLLM's `/models`,
 * Workers AI's search) are read in `listModels()`. OpenAI's listing says
 * nothing, and Anthropic's did not always, so their families are tabled
 * here, as published at this release; a model that is not in the table
 * carries nothing. Each field is absent when not known, never guessed, and what a
 * listing says wins over the table, field by field.
 */

import type { ModelCapabilities, ModelInfo } from '../types.js';
import type { Connection } from './connection.js';

/** The fields of a `ModelInfo` beyond its id and name. */
export type ModelFacts = Omit<ModelInfo, 'id' | 'name'>;

const ALL: ModelCapabilities = { tools: true, images: true, pdf: true };
const TEXT_TOOLS: ModelCapabilities = { tools: true, images: false, pdf: false };
const TEXT_ONLY: ModelCapabilities = { tools: false, images: false, pdf: false };

type Rule = [pattern: RegExp, facts: ModelFacts];

/**
 * Anthropic's families, as the models overview and each model's page say
 * (platform.claude.com/docs/en/models/overview, read 2026-10-19): the 5
 * generation (Fable, Mythos, Opus, Sonnet, Haiku) and the 4.6–4.8 models have
 * a 1M window and 128K output; Opus 4.5 and before, 200k, with an output cap
 * that grew by generation. Haiku 3.5 shipped text-only. Whether a 5 model
 * takes PDFs is left to the Models API, which says (`pdf_input`).
 */
const CLAUDE: Rule[] = [
  [/^claude-(?:fable|mythos|opus|sonnet|haiku)-5(?:-|$)/, { contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { tools: true, images: true } }],
  [/^claude-opus-4-[678](?:-|$)/, { contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: ALL }],
  [/^claude-sonnet-4-6(?:-|$)/, { contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: ALL }],
  [/^claude-opus-4(?:-[01])?(?:-\d{8})?$/, { contextWindow: 200_000, maxOutputTokens: 32_000, capabilities: ALL }],
  [/^claude-opus-4(?:-|$)/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL }],
  [/^claude-(?:sonnet|haiku)-4(?:-|$)/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL }],
  [/^claude-3-7-sonnet/, { contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL }],
  [/^claude-3-5-sonnet/, { contextWindow: 200_000, maxOutputTokens: 8192, capabilities: ALL }],
  [/^claude-3-5-haiku/, { contextWindow: 200_000, maxOutputTokens: 8192, capabilities: { tools: true } }],
  [/^claude-3-(?:opus|sonnet|haiku)/, { contextWindow: 200_000, maxOutputTokens: 4096, capabilities: { tools: true, images: true, pdf: false } }],
];

/** OpenAI's families, the Codex catalog's slugs included (`gpt-5.x-…`); the variants with their own limits first. GPT-6 (Astra, Sol, Luna) as its model pages say, read 2026-10-20. */
const GPT: Rule[] = [
  [/^gpt-6(?:[.-]|$)/, { contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: ALL }],
  [/^gpt-5-chat/, { contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: { tools: false, images: true, pdf: true } }],
  [/^gpt-5(?:[.-]|$)/, { contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL }],
  [/^gpt-4\.1(?:-|$)/, { contextWindow: 1_047_576, maxOutputTokens: 32_768, capabilities: ALL }],
  [/^(?:gpt-4o|chatgpt-4o)(?:-|$)/, { contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: ALL }],
  [/^o1-mini(?:-|$)/, { contextWindow: 128_000, maxOutputTokens: 65_536, capabilities: TEXT_ONLY }],
  [/^o1-preview(?:-|$)/, { contextWindow: 128_000, maxOutputTokens: 32_768, capabilities: TEXT_ONLY }],
  [/^o3-mini(?:-|$)/, { contextWindow: 200_000, maxOutputTokens: 100_000, capabilities: TEXT_TOOLS }],
  [/^o[134](?:-|$)/, { contextWindow: 200_000, maxOutputTokens: 100_000, capabilities: ALL }],
  [/^gpt-4-turbo(?:-|$)/, { contextWindow: 128_000, maxOutputTokens: 4096, capabilities: { tools: true, images: true, pdf: false } }],
  [/^gpt-4(?:-|$)/, { contextWindow: 8192, maxOutputTokens: 8192, capabilities: TEXT_TOOLS }],
  [/^gpt-3\.5-turbo(?:-|$)/, { contextWindow: 16_385, maxOutputTokens: 4096, capabilities: TEXT_TOOLS }],
];

/**
 * Google's chat families, as their model pages say (read 2026-10-20): a
 * 1,048,576-token window and 65,536 out from 2.5 to 4 (Argon), 8,192 out on
 * 2.0 Flash. 2.5 Flash's page lists no PDF input, so its row says nothing of
 * it. The image, speech, live, audio and embedding variants are not chat
 * models and are left out; Google's native listing says their limits.
 */
const GEMINI: Rule[] = [
  [/^gemini-2\.0-flash(?:-|$)/, { contextWindow: 1_048_576, maxOutputTokens: 8192, capabilities: { tools: true, images: true } }],
  [/^gemini-2\.5-flash(?:-lite)?(?:-|$)/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { tools: true, images: true } }],
  [/^gemini-(?:2\.5-pro|3(?:\.\d+)?-(?:pro|flash(?:-lite)?)|4-argon)(?:-|$)/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: ALL }],
];
/**
 * Any other Gemini chat name, for a host whose listing says nothing — the
 * `-latest` aliases (`gemini-pro-latest`, `gemini-flash-latest`,
 * `gemini-flash-lite-latest`), a 4-generation model other than Argon: the
 * window and output every chat family since 2.5 shares, with tools and
 * images, and no word on PDFs. The retired 1.x and 2.0 generations and the
 * `gemini-exp-…` previews of that era (`gemini-exp-1206` was 2.0 Pro's),
 * whose limits differed, are left out. Google's own root does not use this
 * row: its listing says each model's limits, and asking it beats a
 * family-wide figure.
 */
const GEMINI_ANY: Rule[] = [...GEMINI, [/^gemini-(?!1\.|1-|2\.0-|2-0-|exp-)/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { tools: true, images: true } }]];
/** Not chat models: the image (Nano Banana included), speech, live, audio, video (Omni), embedding, robotics and computer-use variants. */
const NOT_CHAT = /image|nano-banana|tts|audio|live|omni|embedding|robotics|computer-use/i;

/** The first rule's facts, as a fresh copy: a caller editing what it got does not edit the table. */
function first(rules: Rule[], id: string): ModelFacts {
  const facts = rules.find(([pattern]) => pattern.test(id))?.[1];
  return facts ? { ...facts, ...(facts.capabilities ? { capabilities: { ...facts.capabilities } } : {}) } : {};
}

/**
 * A model id as the tables spell it: without a gateway's routing prefix
 * (`anthropic/`, `openai/`, `google/`, `models/`), a Bedrock prefix and
 * version (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`), with a Vertex
 * date joined (`claude-opus-4-1@20250805`), with a dotted Claude version
 * hyphenated (`claude-opus-5.5` → `claude-opus-5-5`, `claude-3.5-sonnet` →
 * `claude-3-5-sonnet`, as Anthropic spells them), and without the long-context suffix in any spelling (`[1m]`, `-1m`,
 * `:1m`), which names the 1M-context variant of a 200k model.
 */
export function modelName(id: string): { id: string; million: boolean } {
  let out = id.trim();
  const million = /(?:\[1m\]|-1m|:1m)$/i.test(out);
  out = out.replace(/(?:\[1m\]|-1m|:1m)$/i, '');
  out = out.replace(/^(?:anthropic|openai|google|models)\//, '');
  out = out.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '');
  out = out.replace(/@(\d{8})$/, '-$1');
  out = out.replace(/^(claude(?:-[a-z]+)?-\d+)\.(\d+)(?=-|$)/, '$1-$2');
  return { id: out, million };
}

/** The Claude table's facts for `id` in any of its spellings; the long-context variant has the 1M window. */
function claudeFacts(id: string): ModelFacts {
  const { id: plain, million } = modelName(id);
  const facts = first(CLAUDE, plain);
  return million && facts.contextWindow !== undefined ? { ...facts, contextWindow: 1_000_000 } : facts;
}

/** Google's table's facts for a chat model, the family-wide row included when `any`; nothing for an image, speech or other non-chat variant. */
function geminiTableFacts(id: string, any = false): ModelFacts {
  const plain = modelName(id).id;
  return NOT_CHAT.test(plain) ? {} : first(any ? GEMINI_ANY : GEMINI, plain);
}

/**
 * What the tables know about a model by its name alone, whichever server
 * serves it: the routing prefix and long-context suffix read, the family
 * chosen from the name (`claude-`, `gpt-` / `o1`…`o9`, `gemini-`). Nothing
 * for a name the tables do not know, so a host's own default applies.
 */
export function knownModelInfoByName(id: string): ModelFacts {
  const plain = modelName(id).id;
  if (/^claude-/.test(plain)) return claudeFacts(id);
  if (/^(?:gpt-|chatgpt-|o[1-9](?:-|$))/.test(plain)) return first(GPT, plain);
  if (/^gemini-/.test(plain)) return geminiTableFacts(id, true);
  return {};
}

const hostOf = (baseUrl: string): string => {
  try { return new URL(baseUrl).hostname; } catch { return ''; }
};

/**
 * What the tables say about `id` on this connection: Anthropic's for an
 * Anthropic connection, OpenAI's for ChatGPT and api.openai.com, both by id
 * for an OpenCode sign-in (which serves each lab's models under their own
 * ids), Google's for its OpenAI-compatible root. Nothing for other servers:
 * their listing is the source, or nothing — `knownModelInfoByName` answers
 * by the name alone, for a host that knows the model and not the server.
 */
export function knownModelInfo(conn: Pick<Connection, 'kind' | 'baseUrl' | 'issuer'>, id: string): ModelFacts {
  const plain = modelName(id).id;
  if (conn.kind === 'anthropic') return claudeFacts(id);
  if (conn.kind === 'chatgpt') return first(GPT, plain);
  if (conn.kind === 'openai-compatible') {
    if (conn.issuer === 'opencode') return knownModelInfoByName(id);
    const host = hostOf(conn.baseUrl);
    if (host === 'api.openai.com') return first(GPT, plain);
    // Google's OpenAI-compatible root lists no limits; the table says them.
    if (host === 'generativelanguage.googleapis.com') return geminiTableFacts(id);
  }
  return {};
}

/** The listing's facts over the table's, field by field; `capabilities` merged the same way. */
export function mergeFacts(table: ModelFacts, listing: ModelFacts): ModelFacts {
  const capabilities = table.capabilities || listing.capabilities ? { capabilities: { ...table.capabilities, ...listing.capabilities } } : {};
  return { ...table, ...listing, ...capabilities };
}

/**
 * Anthropic's `/v1/models` entry, which says since the 5 generation: the
 * window (`max_input_tokens`), the output cap (`max_tokens`) and whether the
 * model takes images and PDFs (`capabilities.image_input` / `pdf_input`).
 * Nothing for a field that is missing or null.
 */
export function anthropicFacts(m: Record<string, unknown>): ModelFacts {
  const capabilities = m['capabilities'];
  const supported = (name: string): boolean | undefined => {
    if (!capabilities || typeof capabilities !== 'object') return undefined;
    const entry = (capabilities as Record<string, unknown>)[name];
    const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['supported'] : undefined;
    return typeof value === 'boolean' ? value : undefined;
  };
  const images = supported('image_input');
  const pdf = supported('pdf_input');
  const takes: ModelCapabilities = { ...(images !== undefined ? { images } : {}), ...(pdf !== undefined ? { pdf } : {}) };
  return {
    ...count('contextWindow', m['max_input_tokens']),
    ...count('maxOutputTokens', m['max_tokens']),
    ...(Object.keys(takes).length > 0 ? { capabilities: takes } : {}),
  };
}

/**
 * Gemini's `models.list` entry: its token limits, and what the family takes.
 * A Gemini chat model takes tools, images and PDFs; Gemma and Gemini's image,
 * speech and live models take no tools or PDFs, and whether they take images
 * is unsaid. Another family says nothing.
 */
export function geminiFacts(id: string, m: { inputTokenLimit?: unknown; outputTokenLimit?: unknown }): ModelFacts {
  const limits = { ...count('contextWindow', m.inputTokenLimit), ...count('maxOutputTokens', m.outputTokenLimit) };
  if (/^gemma-/.test(id) || (/^gemini-/.test(id) && /image|tts|audio|live/i.test(id))) return { ...limits, capabilities: { tools: false, pdf: false } };
  if (/^gemini-/.test(id)) return { ...limits, capabilities: { ...ALL } };
  return limits;
}

/**
 * An OpenAI-style `/models` entry that says more than its id: OpenRouter's
 * `context_length`, `top_provider.max_completion_tokens`,
 * `architecture.input_modalities` and `supported_parameters`; vLLM's
 * `max_model_len`. Nothing for a bare `{ id }`, or for a field that is not
 * what it should be.
 */
export function openaiListingFacts(m: Record<string, unknown>): ModelFacts {
  const top = m['top_provider'];
  const architecture = m['architecture'];
  const modalities = strings(architecture && typeof architecture === 'object' ? (architecture as Record<string, unknown>)['input_modalities'] : undefined);
  const parameters = strings(m['supported_parameters']);
  const capabilities: ModelCapabilities = {};
  if (modalities) {
    capabilities.images = modalities.includes('image');
    capabilities.pdf = modalities.includes('file');
  }
  if (parameters) capabilities.tools = parameters.includes('tools');
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
  const calling = bool(value('function_calling'));
  return {
    ...count('contextWindow', value('context_window')),
    ...count('maxOutputTokens', value('max_output_tokens')),
    ...(calling !== undefined ? { capabilities: { tools: calling } } : {}),
  };
}

/** `{ [key]: n }` for a positive count given as a number or a numeric string, else nothing. */
function count(key: 'contextWindow' | 'maxOutputTokens', value: unknown): Partial<Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'>> {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? { [key]: Math.floor(n) } : {};
}

/** An array of strings as itself, anything else as nothing. */
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/** A boolean, or its name, as itself; anything else as nothing. */
function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
