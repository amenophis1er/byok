/** What is known about a model before asking it: the tables, each listing's own fields, and getModelInfo. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelInfo, knownModelInfo, listModels, type Connection } from '../src/core/index.js';
import { anthropicFacts, geminiFacts, mergeFacts, openaiListingFacts, workersAiFacts } from '../src/core/model-info.js';

const ALL = { tools: true, images: true, pdf: true };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('the tables', () => {
  const anthropic: Connection = { kind: 'anthropic', baseUrl: '' };
  const openai: Connection = { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' };

  it('know the Claude families, alias and dated snapshot alike', () => {
    expect(knownModelInfo(anthropic, 'claude-sonnet-4-5-20250929')).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-opus-4-1-20250805')).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-opus-4-20250514')).toMatchObject({ maxOutputTokens: 32_000 });
    expect(knownModelInfo(anthropic, 'claude-opus-4-0')).toMatchObject({ maxOutputTokens: 32_000 });
    expect(knownModelInfo(anthropic, 'claude-opus-4-5')).toMatchObject({ maxOutputTokens: 64_000 });
    expect(knownModelInfo(anthropic, 'claude-haiku-4-5')).toMatchObject({ maxOutputTokens: 64_000 });
    expect(knownModelInfo(anthropic, 'claude-3-5-sonnet-20241022')).toEqual({ contextWindow: 200_000, maxOutputTokens: 8192, capabilities: ALL });
    // Haiku 3.5 shipped text-only: tools yes, the rest unsaid.
    expect(knownModelInfo(anthropic, 'claude-3-5-haiku-20241022')).toEqual({ contextWindow: 200_000, maxOutputTokens: 8192, capabilities: { tools: true } });
    expect(knownModelInfo(anthropic, 'claude-3-opus-20240229')).toMatchObject({ maxOutputTokens: 4096, capabilities: { pdf: false } });
    // A Claude the table does not know: nothing, not a guess.
    expect(knownModelInfo(anthropic, 'claude-opus-6')).toEqual({});
    expect(knownModelInfo(anthropic, 'something-else')).toEqual({});
  });

  it('know the Claude 5 generation and the 1M models of the 4.x line, as the model pages say', () => {
    const five = { contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { tools: true, images: true } };
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-mythos-5-1']) {
      expect(knownModelInfo(anthropic, id), id).toEqual(five);
    }
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(knownModelInfo(anthropic, id), id).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: ALL });
    }
    expect(knownModelInfo(anthropic, 'claude-opus-4-5-20251101')).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-haiku-4-5-20251001')).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-opus-55')).toEqual({});
  });

  it('know the OpenAI families, for api.openai.com and a ChatGPT sign-in, the Codex slugs included', () => {
    expect(knownModelInfo(openai, 'gpt-5')).toEqual({ contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL });
    expect(knownModelInfo({ kind: 'chatgpt', baseUrl: '' }, 'gpt-5.6-sol')).toMatchObject({ contextWindow: 400_000 });
    expect(knownModelInfo(openai, 'gpt-5-chat-latest')).toEqual({ contextWindow: 128_000, maxOutputTokens: 16_384, capabilities: { tools: false, images: true, pdf: true } });
    expect(knownModelInfo(openai, 'gpt-50')).toEqual({});
    expect(knownModelInfo(openai, 'gpt-4.1-mini')).toMatchObject({ contextWindow: 1_047_576, maxOutputTokens: 32_768 });
    expect(knownModelInfo(openai, 'gpt-4o-mini')).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 16_384 });
    expect(knownModelInfo(openai, 'o3-mini')).toMatchObject({ capabilities: { tools: true, images: false, pdf: false } });
    expect(knownModelInfo(openai, 'o1-preview')).toEqual({ contextWindow: 128_000, maxOutputTokens: 32_768, capabilities: { tools: false, images: false, pdf: false } });
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

  it('hand out copies: editing an answer does not edit the table', () => {
    const got = knownModelInfo(openai, 'gpt-5');
    got.capabilities!.images = false;
    got.contextWindow = 1;
    expect(knownModelInfo(openai, 'gpt-5')).toEqual({ contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-sonnet-4-5')).toMatchObject({ capabilities: ALL });
  });
});

describe('each listing\'s own fields', () => {
  it('Anthropic: the limits and inputs the Models API says, nothing for a null or missing field', () => {
    const entry = { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000,
      capabilities: { image_input: { supported: true }, pdf_input: { supported: false }, thinking: { supported: true } } };
    expect(anthropicFacts(entry)).toEqual({ contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { images: true, pdf: false } });
    expect(anthropicFacts({ id: 'claude-3-opus-20240229', max_input_tokens: null, max_tokens: null, capabilities: null })).toEqual({});
    expect(anthropicFacts({ id: 'x', capabilities: { image_input: { supported: 'yes' }, pdf_input: 7 } })).toEqual({});
    expect(anthropicFacts({ id: 'x' })).toEqual({});
  });

  it('Gemini: the token limits, and what the family takes', () => {
    expect(geminiFacts('gemini-2.5-pro', { inputTokenLimit: 1048576, outputTokenLimit: 65536 })).toEqual({ contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ALL });
    // Gemma and the image/speech/live models: no tools, no PDFs; images unsaid. Another family: nothing.
    expect(geminiFacts('gemma-3-27b-it', { inputTokenLimit: 131072, outputTokenLimit: 8192 })).toEqual({ contextWindow: 131072, maxOutputTokens: 8192, capabilities: { tools: false, pdf: false } });
    expect(geminiFacts('gemini-2.5-flash-preview-tts', {})).toEqual({ capabilities: { tools: false, pdf: false } });
    expect(geminiFacts('gemini-2.0-flash-preview-image-generation', {})).toEqual({ capabilities: { tools: false, pdf: false } });
    expect(geminiFacts('future-model', { inputTokenLimit: 1000 })).toEqual({ contextWindow: 1000 });
    // Limits that are not counts are left out.
    expect(geminiFacts('gemini-x', { inputTokenLimit: 'lots', outputTokenLimit: -1 })).toEqual({ capabilities: ALL });
  });

  it('an OpenAI-style entry: OpenRouter\'s fields, vLLM\'s max_model_len, nothing for a bare id or a malformed field', () => {
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
    expect(openaiListingFacts({ id: 'x', architecture: { input_modalities: [null] }, supported_parameters: [7], context_length: '1e5' })).toEqual({});
  });

  it('Workers AI: the properties it lists, when it lists them and they are what they should be', () => {
    const properties = [{ property_id: 'context_window', value: '128000' }, { property_id: 'function_calling', value: 'true' }, { property_id: 'max_output_tokens', value: '4096' }, 'junk', null];
    expect(workersAiFacts(properties)).toEqual({ contextWindow: 128000, maxOutputTokens: 4096, capabilities: { tools: true } });
    expect(workersAiFacts([{ property_id: 'function_calling', value: false }])).toEqual({ capabilities: { tools: false } });
    expect(workersAiFacts([{ property_id: 'function_calling', value: null }, { property_id: 'context_window', value: 'big' }])).toEqual({});
    expect(workersAiFacts(undefined)).toEqual({});
  });

  it('merge field by field, the listing over the table, an explicit false kept', () => {
    expect(mergeFacts({ contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: ALL }, { capabilities: { tools: false } }))
      .toEqual({ contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { tools: false, images: true, pdf: true } });
    expect(mergeFacts({ contextWindow: 200_000 }, { contextWindow: 1_000_000 })).toEqual({ contextWindow: 1_000_000 });
    expect(mergeFacts({}, {})).toEqual({});
  });
});

describe('listModels carries what is known', () => {
  it('under each listed model\'s own fields, field by field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [
      { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: true }, pdf_input: { supported: true } } },
      { id: 'claude-opus-6', display_name: 'Claude Opus 6', max_input_tokens: 2000000, max_tokens: 256000, capabilities: { image_input: { supported: true }, pdf_input: { supported: true } } },
      { id: 'claude-future' },
    ] })));
    expect(await listModels({ kind: 'anthropic', baseUrl: '' }, 'sk')).toEqual([
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL },
      // The listing says PDFs, the table says tools: both.
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: ALL },
      // A Claude newer than the table is known once listed.
      { id: 'claude-opus-6', name: 'Claude Opus 6', contextWindow: 2_000_000, maxOutputTokens: 256_000, capabilities: { images: true, pdf: true } },
      { id: 'claude-future', name: 'claude-future' },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [
      { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', context_length: 400000, top_provider: { max_completion_tokens: 128000 }, architecture: { input_modalities: ['text', 'image', 'file'] }, supported_parameters: ['tools'] },
    ] })));
    expect(await listModels({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, 'or-key'))
      .toEqual([{ id: 'openai/gpt-5', name: 'OpenAI: GPT-5', contextWindow: 400000, maxOutputTokens: 128000, capabilities: ALL }]);
    // A listing that says one thing about a tabled model keeps the table's others.
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'gpt-5', supported_parameters: ['temperature'] }] })));
    expect(await listModels({ kind: 'openai-compatible', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' }, 'tok'))
      .toEqual([{ id: 'gpt-5', name: 'gpt-5', contextWindow: 400_000, maxOutputTokens: 128_000, capabilities: { tools: false, images: true, pdf: true } }]);
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

  it('else asks the listing, and gives the bare id when the listing does not carry it', async () => {
    const fetch = vi.fn(async () => json({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 }] }));
    vi.stubGlobal('fetch', fetch);
    const gemini: Connection = { kind: 'openai-compatible', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' };
    expect(await getModelInfo(gemini, 'g-key')).toEqual({ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxOutputTokens: 65536, capabilities: ALL });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getModelInfo(gemini, 'g-key', 'gemini-9')).toEqual({ id: 'gemini-9', name: 'gemini-9' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'claude-sonnet-4-5' }] })));
    expect(await getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk', 'claude-opus-6')).toEqual({ id: 'claude-opus-6', name: 'claude-opus-6' });
    // A current Claude needs no request.
    expect(await getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk', 'claude-fable-5-1')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    await expect(getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk')).rejects.toThrow('No model given');
  });
});
