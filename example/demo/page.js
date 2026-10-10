// The UI side of byok: everything goes through `createAiClient`, which sends
// messages to the worker. This page never sees a key or a token.
import { createAiClient } from './lib/client.js';
import { OPENAI_COMPATIBLE_PRESETS, normalizeBaseUrl, originPattern } from './lib/types.js';

const ai = createAiClient({ prefix: 'byokdemo' });
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Status line under "Add a connection" ─────────────────────────── */

function status(text, tone = '') {
  const line = $('add-status');
  line.textContent = text;
  line.className = `status ${tone}`;
}

async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { return await work(); } finally { button.disabled = false; button.textContent = original; }
}

/* ── Connections ──────────────────────────────────────────────────── */

let view = { connections: [], activeId: null };

const isOllamaCloud = (c) => c.auth === 'device-key' || /ollama\.com/.test(c.baseUrl);
const provider = (c) => (isOllamaCloud(c) ? 'ollama' : c.kind);
const AUTH = { key: 'API key', oauth: 'Subscription', 'setup-token': 'Setup token', 'device-key': 'Device key' };
const active = () => view.connections.find((c) => c.id === view.activeId);
const authLabel = (c) => (c.auth === 'key' || !c.auth ? (c.hasKey ? 'API key' : 'No key') : AUTH[c.auth] ?? c.auth);

async function refresh() {
  view = await ai.get();
  const list = $('connections');
  list.textContent = '';
  $('conn-empty').hidden = view.connections.length > 0;
  $('conn-count').textContent = view.connections.length ? String(view.connections.length) : '';
  for (const c of view.connections) list.append(connectionRow(c));
  await showActive();
}

function connectionRow(c) {
  const li = document.createElement('li');
  li.className = `conn${c.id === view.activeId ? ' active' : ''}`;

  const avatar = document.createElement('span');
  const kind = provider(c);
  avatar.className = `avatar ${kind}`;
  avatar.textContent = { anthropic: 'C', chatgpt: 'G', ollama: 'O' }[kind] ?? (c.label[0] ?? '?').toUpperCase();

  const text = document.createElement('div');
  text.style.minWidth = '0';
  const name = document.createElement('div');
  name.className = 'conn-name';
  name.textContent = c.label;
  const meta = document.createElement('div');
  meta.className = 'conn-meta';
  meta.textContent = [authLabel(c), c.model || 'no model yet', c.keyHint].filter(Boolean).join(' · ');
  text.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'conn-actions';
  if (c.id === view.activeId) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Active';
    actions.append(badge);
  } else {
    const use = button('Use', 'btn small', async () => { await ai.setActive(c.id); await refresh(); });
    actions.append(use);
  }
  const remove = button('Remove', 'btn small danger', async () => {
    remove.disabled = true;
    const res = await ai.deleteConnection(c.id);
    if (!res.ok) status(res.error, 'error');
    await refresh();
  });
  remove.setAttribute('aria-label', `Remove ${c.label}`);
  actions.append(remove);

  li.append(avatar, text, actions);
  return li;
}

function button(label, className, onclick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

/** A new connection becomes active; refresh, and say so. */
async function connected(label) {
  status(`Connected${label ? `: ${label}` : ''}.`, 'ok');
  await refresh();
}

/* ── Active connection and its models ─────────────────────────────── */

let modelsFor = '';

async function showActive() {
  const conn = active();
  const select = $('model');
  $('send').disabled = !conn;
  if (!conn) {
    $('active-line').textContent = 'No active connection. Add one on the left.';
    select.textContent = '';
    select.disabled = true;
    modelsFor = '';
    return;
  }
  $('active-line').textContent = `${conn.label} · ${authLabel(conn)}`;
  // Reload the list only when the connection (or its revision) changed.
  const key = `${conn.id}:${conn.revision}`;
  if (key === modelsFor) return;
  modelsFor = key;
  select.disabled = true;
  select.innerHTML = '<option>Loading models…</option>';
  const res = await ai.listModels({ kind: conn.kind, baseUrl: conn.baseUrl, apiKey: '', id: conn.id });
  select.textContent = '';
  if (!res.ok) {
    select.append(new Option(conn.model || 'Models unavailable', conn.model));
    $('active-line').textContent += ` · ${res.error}`;
    return;
  }
  const models = res.data;
  if (conn.model && !models.some((m) => m.id === conn.model)) models.unshift({ id: conn.model, name: conn.model });
  for (const m of models) select.append(new Option(m.name, m.id, false, m.id === conn.model));
  select.disabled = models.length === 0;
  // A fresh connection without a model gets a sensible default.
  if (!conn.model && models.length) {
    const pick = models.find((m) => /sonnet/.test(m.id)) ?? models[0];
    select.value = pick.id;
    await setModel(pick.id);
  }
}

async function setModel(model) {
  const conn = active();
  if (!conn) return;
  await ai.saveConnection({ id: conn.id, kind: conn.kind, label: conn.label, baseUrl: conn.baseUrl, model, apiKeyMode: 'keep', makeActive: true });
  view = await ai.get();
  modelsFor = `${conn.id}:${active()?.revision}`;
  const list = $('connections');
  list.textContent = '';
  for (const c of view.connections) list.append(connectionRow(c));
}

$('model').onchange = () => void setModel($('model').value);

/* ── Provider tabs ────────────────────────────────────────────────── */

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t === tab));
    for (const pane of document.querySelectorAll('.pane')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    status('');
  };
}

/* ── Claude ───────────────────────────────────────────────────────── */

for (const radio of document.querySelectorAll('input[name="claude-mode"]')) {
  radio.onchange = () => {
    for (const box of document.querySelectorAll('[data-claude]')) box.hidden = box.dataset.claude !== radio.value;
    status('');
  };
}

$('claude-start').onclick = () => busy($('claude-start'), 'Opening claude.com…', async () => {
  const res = await ai.anthropicLoginStart();
  if (!res.ok) return status(res.error, 'error');
  $('claude-link').href = res.data.authorizeUrl;
  $('claude-paste').hidden = false;
  $('claude-code').focus();
  status('');
});

$('claude-finish').onclick = () => busy($('claude-finish'), 'Connecting…', async () => {
  const pasted = $('claude-code').value.trim();
  if (!pasted) return status('Paste the code from claude.com first.', 'error');
  const res = await ai.anthropicLoginComplete({ pasted, label: 'Claude (Pro/Max)' });
  if (!res.ok) return status(res.error, 'error');
  $('claude-code').value = '';
  $('claude-paste').hidden = true;
  await connected('Claude (Pro/Max)');
});

$('claude-cancel').onclick = () => { $('claude-paste').hidden = true; $('claude-code').value = ''; status(''); };

$('claude-key-save').onclick = () => busy($('claude-key-save'), 'Checking…', async () => {
  const apiKey = $('claude-key').value.trim();
  if (!apiKey) return status('Enter an API key.', 'error');
  // Listing models proves the key before it is stored.
  const models = await ai.listModels({ kind: 'anthropic', baseUrl: '', apiKey });
  if (!models.ok) return status(models.error, 'error');
  const model = (models.data.find((m) => /sonnet/.test(m.id)) ?? models.data[0])?.id ?? '';
  const res = await ai.saveConnection({ kind: 'anthropic', label: 'Claude (API key)', baseUrl: '', model, apiKeyMode: 'set', apiKey, makeActive: true });
  if (!res.ok) return status(res.error, 'error');
  $('claude-key').value = '';
  await connected('Claude (API key)');
});

$('claude-token-save').onclick = () => busy($('claude-token-save'), 'Connecting…', async () => {
  const token = $('claude-token').value.trim();
  if (!token) return status('Paste a setup token.', 'error');
  const res = await ai.anthropicPasteToken({ token, label: 'Claude (setup token)' });
  if (!res.ok) return status(res.error, 'error');
  $('claude-token').value = '';
  await connected('Claude (setup token)');
});

/* ── Device flows: ChatGPT and Ollama Cloud ───────────────────────── */

let flow = 0; // bumping it cancels the running poll

/** Show a device flow's box in place of its start button, or put the button back. */
function startFlow(box) { box.hidden = false; box.previousElementSibling.hidden = true; }
function stopFlow(box) { flow++; box.hidden = true; box.previousElementSibling.hidden = false; }

async function poll(poller, delayMs, box) {
  const mine = ++flow;
  for (;;) {
    await sleep(delayMs);
    if (mine !== flow) return;
    const res = await poller();
    if (mine !== flow) return;
    if (!res.ok) { stopFlow(box); return status(res.error, 'error'); }
    if (res.data.status === 'created') { stopFlow(box); return connected(); }
  }
}

$('chatgpt-start').onclick = () => busy($('chatgpt-start'), 'Starting…', async () => {
  const res = await ai.chatgptLoginStart();
  if (!res.ok) return status(res.error, 'error');
  $('chatgpt-code').textContent = res.data.userCode;
  $('chatgpt-link').href = res.data.verifyUrl;
  startFlow($('chatgpt-box'));
  status('');
  void poll(() => ai.chatgptLoginPoll('ChatGPT'), 5000, $('chatgpt-box'));
});

$('chatgpt-copy').onclick = async () => {
  await navigator.clipboard.writeText($('chatgpt-code').textContent);
  $('chatgpt-copy').textContent = 'Copied';
  setTimeout(() => { $('chatgpt-copy').textContent = 'Copy'; }, 1500);
};
$('chatgpt-cancel').onclick = () => { stopFlow($('chatgpt-box')); status(''); };

$('ollama-start').onclick = () => busy($('ollama-start'), 'Opening ollama.com…', async () => {
  const res = await ai.ollamaLoginStart($('ollama-device').value);
  if (!res.ok) return status(res.error, 'error');
  $('ollama-link').href = res.data.connectUrl;
  startFlow($('ollama-box'));
  status('');
  void poll(() => ai.ollamaLoginPoll(''), res.data.pollMs, $('ollama-box'));
});
$('ollama-cancel').onclick = () => { stopFlow($('ollama-box')); status(''); };

/* ── OpenAI-compatible ────────────────────────────────────────────── */

const presets = [...OPENAI_COMPATIBLE_PRESETS.filter((p) => !/ollama\.com/.test(p.baseUrl)), { label: 'Custom', baseUrl: '', keyOptional: true }];
for (const [i, p] of presets.entries()) $('compat-preset').append(new Option(p.label, String(i)));

function applyPreset() {
  const p = presets[Number($('compat-preset').value)];
  $('compat-url').value = p.baseUrl;
  // A preset with an {account_id} is edited in place; the others are fixed.
  const placeholder = p.baseUrl.indexOf('{');
  $('compat-url').readOnly = p.label !== 'Custom' && placeholder < 0;
  if (placeholder >= 0) {
    $('compat-url').focus();
    $('compat-url').setSelectionRange(placeholder, p.baseUrl.indexOf('}') + 1);
  }
  $('compat-optional').hidden = !p.keyOptional;
  $('compat-local').hidden = !/localhost:11434/.test(p.baseUrl);
  resetCompatModels();
}
function resetCompatModels() {
  $('compat-model').innerHTML = '<option>Load models first</option>';
  $('compat-model').disabled = true;
  $('compat-model-typed-field').hidden = true;
  $('compat-model-typed').value = '';
  $('compat-save').disabled = true;
}
/** Servers that list no models (or have no /models) take a typed model id instead. */
function typeCompatModel() {
  $('compat-model-typed-field').hidden = false;
  $('compat-save').disabled = !$('compat-model-typed').value.trim();
}
const compatModel = () => ($('compat-model-typed-field').hidden ? $('compat-model').value : $('compat-model-typed').value.trim());
$('compat-preset').onchange = applyPreset;
$('compat-url').oninput = resetCompatModels;
$('compat-key').oninput = resetCompatModels;
$('compat-model-typed').oninput = typeCompatModel;
applyPreset();

/** Servers outside the manifest's host permissions need a grant, asked on the click. */
async function ensureOrigin(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) throw new Error('That base URL is not valid.');
  if (await chrome.permissions.contains({ origins: [pattern] })) return;
  if (!(await chrome.permissions.request({ origins: [pattern] }))) throw new Error(`Access to ${pattern} was not granted.`);
}

$('compat-models').onclick = () => busy($('compat-models'), 'Loading…', async () => {
  try {
    const baseUrl = normalizeBaseUrl($('compat-url').value);
    await ensureOrigin(baseUrl);
    const res = await ai.listModels({ kind: 'openai-compatible', baseUrl, apiKey: $('compat-key').value.trim() });
    if (!res.ok) {
      typeCompatModel();
      return status(`${res.error} You can type a model id instead.`, 'error');
    }
    const select = $('compat-model');
    select.textContent = '';
    for (const m of res.data) select.append(new Option(m.name, m.id));
    select.disabled = res.data.length === 0;
    if (res.data.length) {
      $('compat-model-typed-field').hidden = true;
      $('compat-save').disabled = false;
      status(`${res.data.length} models.`);
    } else {
      typeCompatModel();
      status('The server listed no models. Type a model id instead.', 'error');
    }
  } catch (error) {
    status(error.message, 'error');
  }
});

$('compat-save').onclick = () => busy($('compat-save'), 'Connecting…', async () => {
  const baseUrl = normalizeBaseUrl($('compat-url').value);
  // A typed model id skips Load models, which is where access is otherwise granted.
  try { await ensureOrigin(baseUrl); } catch (error) { return status(error.message, 'error'); }
  const apiKey = $('compat-key').value.trim();
  const preset = presets[Number($('compat-preset').value)];
  const label = preset.label === 'Custom' ? '' : preset.label;
  const res = await ai.saveConnection({ kind: 'openai-compatible', label, baseUrl, model: compatModel(),
    apiKeyMode: apiKey ? 'set' : 'clear', apiKey, makeActive: true });
  if (!res.ok) return status(res.error, 'error');
  $('compat-key').value = '';
  resetCompatModels();
  await connected(label);
});

/* ── Demo tools, run in this page ─────────────────────────────────── */

const TOOLS = [
  {
    name: 'get_time',
    description: "The owner's current local date, time and IANA time zone.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'calculate',
    description: 'Evaluate an arithmetic expression exactly. Supports + - * / % ^ and parentheses.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'For example "(2340 * 0.175) * 12"' } }, required: ['expression'], additionalProperties: false },
  },
];

function runTool(call) {
  if (call.argsError) return { error: `Invalid JSON arguments: ${call.argsError.message}` };
  if (call.name === 'get_time') {
    const now = new Date();
    return { iso: now.toISOString(), local: now.toLocaleString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  if (call.name === 'calculate') {
    try { return { result: calculate(String(call.args?.expression ?? '')) }; } catch (error) { return { error: error.message }; }
  }
  return { error: `No tool named ${call.name}.` };
}

/** A small recursive-descent evaluator: extension pages forbid eval, and should. */
function calculate(source) {
  const tokens = source.replace(/,/g, '').match(/\d+(?:\.\d+)?|[-+*/%^()]/g) ?? [];
  if (tokens.join('') !== source.replace(/[\s,]/g, '')) throw new Error('Only numbers and + - * / % ^ ( ) are allowed.');
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term(); return v; };
  const term = () => {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next(); const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const power = () => { const b = unary(); return peek() === '^' ? (next(), b ** power()) : b; };
  const unary = () => (peek() === '-' ? (next(), -unary()) : peek() === '+' ? (next(), unary()) : atom());
  const atom = () => {
    const t = next();
    if (t === '(') { const v = expr(); if (next() !== ')') throw new Error('Missing ")".'); return v; }
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    throw new Error('Incomplete expression.');
  };
  const value = expr();
  if (i < tokens.length) throw new Error(`Unexpected "${peek()}".`);
  if (!Number.isFinite(value)) throw new Error('The result is not a finite number.');
  return value;
}

/* ── Chat ─────────────────────────────────────────────────────────── */

const SYSTEM = 'You are the assistant in the byok demo, a Chrome extension. Be concise. Use the tools when they help: never guess the time or do arithmetic in your head.';
const MAX_TURNS = 8;
let history = [];
let running = false;

function add(className, text) {
  $('welcome').hidden = true;
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  $('log').append(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

/** Just enough Markdown for chat replies — **bold**, `code` — on escaped text, so nothing from the model becomes markup. */
function addReply(text) {
  const el = add('msg assistant', '');
  const escaped = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  el.innerHTML = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function addTool(call, result, timing) {
  const box = document.createElement('details');
  box.className = 'tool';
  const summary = document.createElement('summary');
  const name = document.createElement('code');
  name.textContent = call.name;
  summary.append('Called ', name, result.error ? ' (failed)' : '', timing ? ` · ${timing}` : '');
  const pre = document.createElement('pre');
  pre.textContent = `arguments: ${JSON.stringify(call.args ?? {})}\nresult:    ${JSON.stringify(result)}`;
  box.append(summary, pre);
  $('log').append(box);
  box.scrollIntoView({ block: 'end' });
}

async function send(text) {
  const conn = active();
  if (!conn || running || !text.trim()) return;
  running = true;
  $('send').disabled = true;
  $('input').value = '';
  autosize();
  add('msg user', text);
  const before = history.length;
  history.push({ role: 'user', content: text });
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const thinking = add('thinking', '');
      thinking.innerHTML = '<span class="spinner"></span>Thinking…';
      const started = performance.now();
      const res = await ai.chat({
        system: SYSTEM,
        messages: history,
        tools: $('tools').checked ? TOOLS : undefined,
        maxTokens: 2048,
        // Pinned: a connection edited or removed meanwhile fails the call instead of switching provider.
        connectionId: conn.id,
        connectionRevision: active()?.revision,
      });
      thinking.remove();
      if (!res.ok) {
        add('msg error', `${res.error}${res.retryable ? ' You can send again.' : ''}`);
        history.length = before; // the failed exchange is not resent
        return;
      }
      history.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, providerState: res.providerState });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const usage = res.usage ? ` · ${res.usage.inputTokens} in / ${res.usage.outputTokens} out` : '';
      const timing = `${active()?.model ?? ''} · ${seconds}s${usage}`;
      // The turn's timing goes under its text, or on its first tool call when it only called tools.
      if (res.text) { addReply(res.text); add('meta', timing); }
      if (!res.toolCalls?.length) return;
      for (const [index, call] of res.toolCalls.entries()) {
        const result = runTool(call);
        addTool(call, result, !res.text && index === 0 ? `${seconds}s` : '');
        history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result), isError: Boolean(result.error) });
      }
    }
    add('msg error', `Stopped after ${MAX_TURNS} model turns.`);
  } finally {
    running = false;
    $('send').disabled = !active();
    $('input').focus();
  }
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

$('composer').onsubmit = (event) => { event.preventDefault(); void send($('input').value); };
$('input').oninput = autosize;
$('input').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send($('input').value); }
};
for (const chip of document.querySelectorAll('.chip')) chip.onclick = () => void send(chip.textContent);
$('clear').onclick = () => {
  history = [];
  for (const el of [...$('log').children]) if (el.id !== 'welcome') el.remove();
  $('welcome').hidden = false;
  $('input').focus();
};

void refresh();
