/** What is known about a model before asking it: the tables, each listing's own fields, and getModelInfo. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelInfo, knownModelInfo, listModels, type Connection } from '../src/core/index.js';
import { geminiFacts, openaiListingFacts, workersAiFacts } from '../src/core/model-info.js';

const ALL = { tools: true, images: true, pdf: true };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('the tables', () => {
  const anthropic: Connection = { kind: 'anthropic', baseUrl: '' };
  const openai: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };

  it('know the Claude families, and that every Claude takes tools, images and PDFs', () => {
    expect(knownModelInfo(anthropic, 'claude-sonnet-4-5-20250929')).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-opus-4-1-20250805')).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-opus-4-5')).toMatchObject({ maxOutputTokens: 64_000 });
    expect(knownModelInfo(anthropic, 'claude-haiku-4-5')).toMatchObject({ maxOutputTokens: 64_000 });
    expect(knownModelInfo(anthropic, 'claude-3-5-haiku-20241022')).toEqual({ contextWindow: 200_000, maxOutputTokens: 8192, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-3-opus-20240229')).toMatchObject({ maxOutputTokens: 4096, capabilities: { pdf: false } });
    // A Claude the table does not know: only what is certain.
    expect(knownModelInfo(anthropic, 'claude-opus-5-5')).toEqual({ capabilities: ALL });
    expect(knownModelInfo(anthropic, 'something-else')).toEqual({});
  });

  it('know the OpenAI families, for api.openai.com and a ChatGPT sign-in, the Codex slugs included', () => {
    expect(knownModelInfo(openai, 'gpt-5')).toEqual({ contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL });
    expect(knownModelInfo({ kind: 'chatgpt', baseUrl: '' }, 'gpt-5.6-sol')).toMatchObject({ contextWindow: 400_000 });
    expect(knownModelInfo(openai, 'gpt-4.1-mini')).toMatchObject({ contextWindow: 1_047_576, maxOutputTokens: 32_768 });
    expect(knownModelInfo(openai, 'gpt-4o-mini')).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 16_384 });
    expect(knownModelInfo(openai, 'o3-mini')).toMatchObject({ capabilities: { tools: true, images: false, pdf: false } });
    expect(knownModelInfo(openai, 'o4-mini')).toMatchObject({ contextWindow: 200_000, capabilities: ALL });
    expect(knownModelInfo(openai, 'gpt-3.5-turbo')).toMatchObject({ contextWindow: 16_385, capabilities: { images: false } });
    expect(knownModelInfo(openai, 'text-embedding-3-small')).toEqual({});
  });

  it('say nothing for another server, and read both labs\' ids on an OpenCode sign-in', () => {
    expect(knownModelInfo({ kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }, 'gpt-4o')).toEqual({});
    expect(knownModelInfo({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }, 'claude-3-5-haiku')).toEqual({});
    const opencode: Connection = { kind: 'openai-compatible', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' };
    expect(knownModelInfo(opencode, 'claude-sonnet-4-5')).toMatchObject({ maxOutputTokens: 64_000 });
    expect(knownModelInfo(opencode, 'gpt-5.1')).toMatchObject({ contextWindow: 400_000 });
    expect(knownModelInfo(opencode, 'kimi-k2')).toEqual({});
  });
});

describe('each listing\'s own fields', () => {
  it('Gemini: the token limits, and what the family takes', () => {
    expect(geminiFacts('gemini-2.5-pro', { inputTokenLimit: 1048576, outputTokenLimit: 65536 })).toEqual({ contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ALL });
    expect(geminiFacts('gemma-3-27b-it', { inputTokenLimit: 131072, outputTokenLimit: 8192 })).toMatchObject({ capabilities: { tools: false, images: true, pdf: false } });
    expect(geminiFacts('gemini-2.0-flash-preview-image-generation', {})).toEqual({ capabilities: { tools: false, images: true, pdf: false } });
    // Limits that are not counts are left out.
    expect(geminiFacts('g', { inputTokenLimit: 'lots', outputTokenLimit: -1 })).toEqual({ capabilities: ALL });
  });

  it('an OpenAI-style entry: OpenRouter\'s fields, vLLM\'s max_model_len, nothing for a bare id', () => {
    const openrouter = {
      id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 64000, is_moderated: true },
      architecture: { modality: 'text+image+file->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'tool_choice', 'tools', 'top_p'],
    };
    expect(openaiListingFacts(openrouter)).toEqual({ contextWindow: 1000000, maxOutputTokens: 64000, capabilities: ALL });
    expect(openaiListingFacts({ id: 'x', architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'] }))
      .toEqual({ capabilities: { tools: false, images: false, pdf: false } });
    expect(openaiListingFacts({ id: 'meta-llama/Llama-3.1-8B-Instruct', object: 'model', max_model_len: 131072 })).toEqual({ contextWindow: 131072 });
    expect(openaiListingFacts({ id: 'gpt-oss:20b', object: 'model', owned_by: 'library' })).toEqual({});
  });

  it('Workers AI: the properties it lists, when it lists them', () => {
    const properties = [{ property_id: 'context_window', value: '128000' }, { property_id: 'function_calling', value: 'true' }, { property_id: 'max_output_tokens', value: '4096' }, 'junk', null];
    expect(workersAiFacts(properties)).toEqual({ contextWindow: 128000, maxOutputTokens: 4096, capabilities: { tools: true } });
    expect(workersAiFacts([{ property_id: 'function_calling', value: 'false' }])).toEqual({ capabilities: { tools: false } });
    expect(workersAiFacts(undefined)).toEqual({});
  });
});

describe('listModels carries what is known', () => {
  it('under each listed model\'s own fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' }, { id: 'claude-future' }] })));
    expect(await listModels({ kind: 'anthropic', baseUrl: '' }, 'sk')).toEqual([
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL },
      { id: 'claude-future', name: 'claude-future', capabilities: ALL },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [
      { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', context_length: 400000, top_provider: { max_completion_tokens: 128000 }, architecture: { input_modalities: ['text', 'image', 'file'] }, supported_parameters: ['tools'] },
    ] })));
    expect(await listModels({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, 'or-key'))
      .toEqual([{ id: 'openai/gpt-5', name: 'OpenAI: GPT-5', contextWindow: 400000, maxOutputTokens: 128000, capabilities: ALL }]);
    // A plain server's bare ids stay bare.
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'gpt-oss:20b', object: 'model' }] })));
    expect(await listModels({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }, '')).toEqual([{ id: 'gpt-oss:20b', name: 'gpt-oss:20b' }]);
  });
});

describe('getModelInfo', () => {
  it('answers from the tables without a request when they know the model', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await getModelInfo({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }, 'k'))
      .toEqual({ id: 'gpt-5', name: 'gpt-5', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL });
    expect(await getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk', 'claude-haiku-4-5')).toMatchObject({ id: 'claude-haiku-4-5', maxOutputTokens: 64_000 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('else asks the listing, and gives the id with what is certain when the listing does not carry it', async () => {
    const fetch = vi.fn(async () => json({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 }] }));
    vi.stubGlobal('fetch', fetch);
    const gemini: Connection = { kind: 'openai-compatible', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' };
    expect(await getModelInfo(gemini, 'g-key')).toEqual({ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ALL });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getModelInfo(gemini, 'g-key', 'gemini-9')).toEqual({ id: 'gemini-9', name: 'gemini-9' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'claude-sonnet-4-5' }] })));
    expect(await getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk', 'claude-opus-5-5')).toEqual({ id: 'claude-opus-5-5', name: 'claude-opus-5-5', capabilities: ALL });
    await expect(getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk')).rejects.toThrow('No model given');
  });
});
