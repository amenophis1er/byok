/**
 * Live smoke test (manual): a real two-turn tool round trip through the
 * library's core — `chat()` from `@amenophis1er/byok/core`, as a Node
 * program would use it — per provider with credentials.
 *
 *   npm run build && node scripts/smoke.mjs
 *
 * - Ollama Cloud: signs with the device key in ~/.ollama (from `ollama signin`).
 * - Anthropic / OpenAI / OpenRouter / Gemini: ANTHROPIC_API_KEY / OPENAI_API_KEY /
 *   OPENROUTER_API_KEY / GEMINI_API_KEY, each skipped when unset. Models via SMOKE_*_MODEL.
 *
 * Turn 1 must call the tool; turn 2 sends the tool result back and must answer
 * with text that uses it. Costs a few hundred tokens per provider.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chat, signRequest } from '../dist/core/index.js';

const TOOLS = [{
  name: 'get_price',
  description: 'Look up the price of a product in the fixture shop.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['product'], properties: { product: { type: 'string' } } },
}];
const SYSTEM = 'You answer questions about the shop. Use the get_price tool; never guess a price.';
const QUESTION = 'How much is the blue mug? Answer in one sentence.';

async function ollamaPair() {
  const file = `${homedir()}/.ollama/id_ed25519`;
  if (!existsSync(file)) return null;
  const b = Buffer.from(readFileSync(file, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  let o = 15;
  const str = () => { const n = b.readUInt32BE(o); o += 4; const v = b.subarray(o, o + n); o += n; return v; };
  str(); str(); str(); o += 4; str(); const priv = str();
  let p = 8;
  const pstr = () => { const n = priv.readUInt32BE(p); p += 4; const v = priv.subarray(p, p + n); p += n; return v; };
  pstr(); const pub = pstr(); const sk = pstr();
  const jwk = { kty: 'OKP', crv: 'Ed25519', d: sk.subarray(0, 32).toString('base64url'), x: pub.toString('base64url') };
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']),
    publicKey: await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, true, ['verify']),
  };
}

/** One turn through the core, as a host would run it: the connection, its credential, the request. */
const turnOn = (conn, credential) => (messages) =>
  chat(conn, credential, { system: SYSTEM, messages, tools: TOOLS, maxTokens: 4000 });

async function roundTrip(name, turn) {
  const messages = [{ role: 'user', content: QUESTION }];
  const first = await turn(messages);
  if (!first.ok) throw new Error(`turn 1 failed: ${first.error}`);
  const call = first.toolCalls?.[0];
  if (!call || call.name !== 'get_price') throw new Error(`turn 1 made no get_price call (stop ${first.stopReason}, text ${JSON.stringify(first.text)})`);
  if (first.toolCalls.length > 1) throw new Error('parallel calls were not turned off');
  messages.push({ role: 'assistant', content: first.text, toolCalls: first.toolCalls, providerState: first.providerState });
  messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ product: call.args?.product, price: '$12.40' }) });
  const second = await turn(messages);
  if (!second.ok) throw new Error(`turn 2 failed: ${second.error}`);
  if (!/12\.40/.test(second.text ?? '')) throw new Error(`turn 2 did not use the tool result: ${JSON.stringify(second.text)}`);
  console.log(`PASS ${name}: called get_price(${JSON.stringify(call.args)}), then answered: ${second.text}`);
}

const results = [];
async function run(name, available, fn) {
  if (!available) { console.log(`SKIP ${name}: no credentials`); return; }
  try { await fn(); results.push(true); } catch (error) { console.log(`FAIL ${name}: ${error.message}`); results.push(false); }
}

const pair = await ollamaPair();
const env = process.env;
await run('ollama.com (device key)', pair, () => roundTrip('ollama.com (device key)',
  turnOn({ kind: 'openai-compatible', auth: 'device-key', baseUrl: 'https://ollama.com/v1', model: env.SMOKE_OLLAMA_MODEL ?? 'glm-5.3-flash' }, (method, url) => signRequest(pair, method, url))));
await run('Anthropic', env.ANTHROPIC_API_KEY, () => roundTrip('Anthropic',
  turnOn({ kind: 'anthropic', baseUrl: '', model: env.SMOKE_ANTHROPIC_MODEL ?? 'claude-opus-5' }, env.ANTHROPIC_API_KEY)));
await run('OpenAI', env.OPENAI_API_KEY, () => roundTrip('OpenAI',
  turnOn({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: env.SMOKE_OPENAI_MODEL ?? 'gpt-5.5' }, env.OPENAI_API_KEY)));
await run('OpenAI (Responses)', env.OPENAI_API_KEY, () => roundTrip('OpenAI (Responses)',
  turnOn({ kind: 'openai-compatible', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: env.SMOKE_OPENAI_MODEL ?? 'gpt-5.5' }, env.OPENAI_API_KEY)));
await run('Gemini', env.GEMINI_API_KEY, () => roundTrip('Gemini',
  turnOn({ kind: 'openai-compatible', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: env.SMOKE_GEMINI_MODEL ?? 'gemini-3.8-flash' }, env.GEMINI_API_KEY)));
await run('OpenRouter', env.OPENROUTER_API_KEY, () => roundTrip('OpenRouter',
  turnOn({ kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: env.SMOKE_OPENROUTER_MODEL ?? 'openai/gpt-5.5' }, env.OPENROUTER_API_KEY)));

process.exit(results.every(Boolean) ? 0 : 1);
