import {
  PROTOCOL_VERSION,
  type AIAnthropicLoginStart,
  type AIChatgptLoginStart,
  type AIChatgptPoll,
  type AIChatRequest,
  type AIChatResult,
  type AIConfigView,
  type AIOllamaLoginStart,
  type AIOllamaPoll,
  type AIOpencodeLoginStart,
  type AIOpencodePoll,
  type AIResult,
  type ModelInfo,
  type ProviderKind,
  type AISaveConnectionRequest,
} from './types.js';

/**
 * Typed client for UI surfaces (content scripts, options/settings pages,
 * side panels). Every call is one chrome.runtime.sendMessage to the
 * background handlers registered with the SAME prefix.
 */

export interface AiClient {
  /** Redacted config: connections without secrets. */
  get(): Promise<AIConfigView>;
  setActive(id: string | null): Promise<AIResult<null>>;
  saveConnection(
    input: Omit<AISaveConnectionRequest, 'type'>,
  ): Promise<AIResult<{ id: string }>>;
  deleteConnection(id: string): Promise<AIResult<null>>;
  listModels(input: {
    kind: ProviderKind;
    baseUrl: string;
    apiKey: string;
    id?: string;
  }): Promise<AIResult<ModelInfo[]>>;
  /** One text completion through the active connection. */
  complete(input: { system: string; prompt: string; maxTokens?: number }): Promise<AIResult<string>>;
  /** One model turn with tools. Inside the worker, call `chat()` from `/background` directly instead. */
  chat(input: AIChatRequest): Promise<AIChatResult>;
  anthropicLoginStart(): Promise<AIResult<AIAnthropicLoginStart>>;
  anthropicLoginComplete(input: { pasted: string; label: string }): Promise<AIResult<{ id: string }>>;
  anthropicPasteToken(input: { token: string; label: string }): Promise<AIResult<{ id: string }>>;
  chatgptLoginStart(): Promise<AIResult<AIChatgptLoginStart>>;
  chatgptLoginPoll(label: string): Promise<AIResult<AIChatgptPoll>>;
  /** Ollama Cloud: open ollama.com/connect for a new device key. */
  ollamaLoginStart(deviceName?: string): Promise<AIResult<AIOllamaLoginStart>>;
  ollamaLoginPoll(label: string): Promise<AIResult<AIOllamaPoll>>;
  /** OpenCode Console: a device code, approved on opencode.ai (the worker opens the page). '' = label "OpenCode". */
  opencodeLoginStart(): Promise<AIResult<AIOpencodeLoginStart>>;
  opencodeLoginPoll(label: string): Promise<AIResult<AIOpencodePoll>>;
}

export function createAiClient(options: { prefix?: string } = {}): AiClient {
  const p = options.prefix ?? 'aiconnect';
  const send = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> =>
    chrome.runtime.sendMessage({ ...payload, type: `${p}:${type}`, v: PROTOCOL_VERSION }) as Promise<T>;

  return {
    // (the one answer that is not a result of its own: a worker that could not read the connections says
    // { ok: false, error }, which is thrown here rather than handed on as a list of connections)
    get: async () => {
      const view = await send<AIConfigView | { ok: false; error?: string }>('ai-get');
      if (view && 'ok' in view && view.ok === false) throw new Error(view.error || 'The AI connections could not be read.');
      return view as AIConfigView;
    },
    setActive: (id) => send('ai-set-active', { id }),
    saveConnection: (input) => send('ai-save-connection', { ...input }),
    deleteConnection: (id) => send('ai-delete-connection', { id }),
    listModels: (input) => send('ai-list-models', { ...input }),
    complete: (input) => send('ai-complete', { ...input }),
    chat: (input) => send('ai-chat', { ...input }),
    anthropicLoginStart: () => send('ai-anthropic-login-start'),
    anthropicLoginComplete: (input) => send('ai-anthropic-login-complete', { ...input }),
    anthropicPasteToken: (input) => send('ai-anthropic-paste-token', { ...input }),
    chatgptLoginStart: () => send('ai-chatgpt-login-start'),
    chatgptLoginPoll: (label) => send('ai-chatgpt-login-poll', { label }),
    ollamaLoginStart: (deviceName) => send('ai-ollama-login-start', { deviceName }),
    ollamaLoginPoll: (label) => send('ai-ollama-login-poll', { label }),
    opencodeLoginStart: () => send('ai-opencode-login-start'),
    opencodeLoginPoll: (label) => send('ai-opencode-login-poll', { label }),
  };
}
