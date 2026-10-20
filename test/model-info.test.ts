/** What is known about a model before asking it: the tables, each listing's own fields, and getModelInfo. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModelInfo, knownModelInfo, knownModelInfoByName, listModels, modelName, type Connection } from '../src/core/index.js';
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

  it('read a Claude id in its other spellings: the [1m] variant, Bedrock and Vertex ids', () => {
    expect(knownModelInfo(anthropic, 'claude-sonnet-4-5[1m]')).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 64_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'claude-opus-4-1-20250805[1m]')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 32_000 });
    expect(knownModelInfo(anthropic, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, capabilities: ALL });
    expect(knownModelInfo(anthropic, 'anthropic.claude-3-5-haiku-20241022-v1:0')).toMatchObject({ maxOutputTokens: 8192 });
    expect(knownModelInfo(anthropic, 'claude-opus-4-1@20250805')).toMatchObject({ maxOutputTokens: 32_000 });
    const opencode: Connection = { kind: 'openai-compatible', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' };
    expect(knownModelInfo(opencode, 'claude-haiku-4-5[1m]')).toMatchObject({ contextWindow: 1_000_000 });
    // An unknown model in a known spelling is still unknown.
    expect(knownModelInfo(anthropic, 'us.anthropic.claude-opus-6-v1:0')).toEqual({});
    expect(knownModelInfo(anthropic, 'claude-opus-6[1m]')).toEqual({});
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

  it('answer by name alone, whichever gateway serves the model, the routing prefix and long-context suffix read', () => {
    expect(knownModelInfoByName('anthropic/claude-sonnet-5-5')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(knownModelInfoByName('us.anthropic.claude-opus-5-5-v1:0')).toMatchObject({ contextWindow: 1_000_000 });
    expect(knownModelInfoByName('claude-sonnet-4-5-1m')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    expect(knownModelInfoByName('claude-sonnet-4-5:1m')).toMatchObject({ contextWindow: 1_000_000 });
    expect(knownModelInfoByName('openai/gpt-5.5')).toMatchObject({ contextWindow: 400_000 });
    expect(knownModelInfoByName('o3')).toMatchObject({ contextWindow: 200_000 });
    expect(knownModelInfoByName('google/gemini-2.5-pro')).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: ALL });
    expect(knownModelInfoByName('models/gemini-3.1-pro-preview')).toMatchObject({ contextWindow: 1_048_576 });
    expect(knownModelInfoByName('kimi-k2')).toEqual({});
    expect(knownModelInfoByName('')).toEqual({});
    expect(modelName('anthropic/claude-opus-4-1@20250805[1m]')).toEqual({ id: 'claude-opus-4-1-20250805', million: true });
  });

  it('read a dotted Claude version as Anthropic spells it, by name and by connection', () => {
    expect(modelName('claude-opus-5.5')).toEqual({ id: 'claude-opus-5-5', million: false });
    expect(modelName('anthropic/claude-3.5-sonnet:1m')).toEqual({ id: 'claude-3-5-sonnet', million: true });
    expect(modelName('claude-opus-4.1-20250805')).toEqual({ id: 'claude-opus-4-1-20250805', million: false });
    expect(knownModelInfoByName('claude-opus-5.5')).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000, capabilities: { tools: true, images: true } });
    expect(knownModelInfoByName('anthropic/claude-3.5-sonnet')).toMatchObject({ maxOutputTokens: 8192 });
    expect(knownModelInfoByName('openai/claude-opus-4.1')).toMatchObject({ maxOutputTokens: 32_000 });
    expect(knownModelInfo(anthropic, 'claude-sonnet-4.5')).toMatchObject({ maxOutputTokens: 64_000 });
    // A dot elsewhere is not a version: nothing is rewritten, nothing is known.
    expect(modelName('claude-opus.5-5')).toEqual({ id: 'claude-opus.5-5', million: false });
    expect(knownModelInfoByName('claude-opus-55.5')).toEqual({});
  });

  it('answer by name for any other Gemini chat model — the -latest aliases, a 4-generation model — and not for the 1.x and 2.0 lines, their exp previews, or a non-chat variant', () => {
    const shared = { contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { tools: true, images: true } };
    for (const id of ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest', 'gemini-4-neon-preview', 'google/gemini-4.2-xenon', 'models/gemini-5-pro']) {
      expect(knownModelInfoByName(id), id).toEqual(shared);
    }
    // The tabled families keep their own rows ahead of the family-wide one.
    expect(knownModelInfoByName('gemini-2.5-pro')).toMatchObject({ capabilities: ALL });
    expect(knownModelInfoByName('gemini-2.0-flash-001')).toMatchObject({ maxOutputTokens: 8192 });
    // gemini-exp-1206 was 2.0 Pro's preview, with that generation's limits: not the family-wide row.
    for (const id of ['gemini-1.5-pro', 'gemini-1.5-flash-8b', 'gemini-1.0-pro', 'gemini-2.0-pro-exp', 'gemini-exp-1206', 'gemini-exp-image-1206', 'gemini-4-neon-tts', 'gemini-embedding-2', 'gemini-nano-banana-2.1', 'gemini-omni-1.1-flash', 'gemini-3-pro-image-preview']) {
      expect(knownModelInfoByName(id), id).toEqual({});
    }
    // Google's own root does not get the family-wide row: its listing says each model's limits.
    const google: Connection = { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' };
    expect(knownModelInfo(google, 'gemini-flash-latest')).toEqual({});
    expect(knownModelInfo(google, 'gemini-4-neon-preview')).toEqual({});
    // An OpenCode sign-in lists no limits: by name, the row applies.
    const opencode: Connection = { kind: 'openai-compatible', issuer: 'opencode', baseUrl: 'https://opencode.ai/inference/v1' };
    expect(knownModelInfo(opencode, 'gemini-pro-latest')).toEqual(shared);
  });

  it('know the Gemini chat families and GPT-6, and leave the image, speech and live variants to the listing', () => {
    const gemini: Connection = { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' };
    expect(knownModelInfo(gemini, 'gemini-2.5-pro')).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: ALL });
    expect(knownModelInfo(gemini, 'gemini-2.5-flash')).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 65_536, capabilities: { tools: true, images: true } });
    expect(knownModelInfo(gemini, 'gemini-2.5-flash-lite')).toMatchObject({ maxOutputTokens: 65_536 });
    expect(knownModelInfo(gemini, 'gemini-3-flash-preview')).toMatchObject({ contextWindow: 1_048_576, capabilities: ALL });
    expect(knownModelInfo(gemini, 'gemini-3.8-flash')).toMatchObject({ maxOutputTokens: 65_536 });
    expect(knownModelInfo(gemini, 'gemini-4-argon')).toMatchObject({ contextWindow: 1_048_576, capabilities: ALL });
    expect(knownModelInfo(gemini, 'gemini-2.0-flash')).toMatchObject({ maxOutputTokens: 8192 });
    for (const other of ['gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-live', 'gemini-embedding-001', 'gemma-3-27b-it', 'gemini-2.5-flash-native-audio-dialog']) {
      expect(knownModelInfo(gemini, other), other).toEqual({});
    }
    expect(knownModelInfo(openai, 'gpt-6-astra')).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: ALL });
    expect(knownModelInfo(openai, 'gpt-6.1-sol')).toMatchObject({ contextWindow: 1_050_000 });
    expect(knownModelInfo({ kind: 'chatgpt', baseUrl: '' }, 'gpt-6-luna')).toMatchObject({ contextWindow: 1_050_000 });
    expect(knownModelInfo(openai, 'gpt-60')).toEqual({});
    // The by-connection answer stays by connection: another server's Claude is still unknown there.
    expect(knownModelInfo({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, 'anthropic/claude-sonnet-5-5')).toEqual({});
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

  it('follows every page of the Anthropic catalog, and stops on a page that does not move', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'claude-b' }], has_more: true, last_id: 'claude-b' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'claude-c' }], has_more: false, last_id: 'claude-c' }));
    vi.stubGlobal('fetch', fetch);
    expect((await listModels({ kind: 'anthropic', baseUrl: '' }, 'sk')).map((m) => m.id)).toEqual(['claude-a', 'claude-b', 'claude-c']);
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.anthropic.com/v1/models?limit=100',
      'https://api.anthropic.com/v1/models?limit=100&after_id=claude-a',
      'https://api.anthropic.com/v1/models?limit=100&after_id=claude-b',
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'claude-x' }], has_more: true, last_id: 'claude-x' })));
    expect((await listModels({ kind: 'anthropic', baseUrl: '' }, 'sk')).length).toBeLessThanOrEqual(20);
  });

  it('keeps what the Codex catalog says of a model under the table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 1, context_window: 272000, input_modalities: ['text', 'image'] }] })));
    expect(await listModels({ kind: 'chatgpt', baseUrl: '' }, 'tok')).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, maxOutputTokens: 128_000, capabilities: ALL },
    ]);
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
    // A Gemini the table does not know yet: the listing says.
    const fetch = vi.fn(async () => json({ models: [{ name: 'models/gemini-9-nova', displayName: 'Gemini 9 Nova', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 2097152, outputTokenLimit: 65536 }] }));
    vi.stubGlobal('fetch', fetch);
    const gemini: Connection = { kind: 'openai-compatible', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-9-nova' };
    expect(await getModelInfo(gemini, 'g-key')).toEqual({ id: 'gemini-9-nova', name: 'Gemini 9 Nova', contextWindow: 2097152, maxOutputTokens: 65536, capabilities: ALL });
    expect(fetch).toHaveBeenCalledTimes(1);
    // A tabled Gemini needs no request on Google's OpenAI-compatible root.
    expect(await getModelInfo(gemini, 'g-key', 'gemini-2.5-pro')).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 65_536 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getModelInfo(gemini, 'g-key', 'gemini-9')).toEqual({ id: 'gemini-9', name: 'gemini-9' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'claude-sonnet-4-5' }] })));
    expect(await getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk', 'claude-opus-6')).toEqual({ id: 'claude-opus-6', name: 'claude-opus-6' });
    // A current Claude needs no request.
    expect(await getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk', 'claude-fable-5-1')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    await expect(getModelInfo({ kind: 'anthropic', baseUrl: '' }, 'sk')).rejects.toThrow('No model given');
  });
});
