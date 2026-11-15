import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/recognize.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { recogConfig, saveRecogConfig, recogReady, recognize } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
beforeEach(() => {
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  } });
  globalThis.fetch = () => { throw Error('Unexpected network request'); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});
const useOpenAI = () => saveRecogConfig({ provider: 'openai', key: 'test-openai-key', model: 'gpt-5.4-mini' });
const reply = (text) => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
] });

test('legacy Claude settings survive switching, and each provider keeps a separate key and model', () => {
  localStorage.setItem('margin.recog', JSON.stringify({ key: 'test-claude-key', model: 'claude-opus-5-5' }));
  assert.deepEqual(recogConfig(), { provider: 'claude', key: 'test-claude-key', model: 'claude-opus-5-5' });
  saveRecogConfig(recogConfig('openai'));
  assert.equal(recogConfig().key, '');
  assert.equal(recogReady(), false);
  useOpenAI();
  saveRecogConfig({ ...recogConfig(), model: 'gpt-5.4' });
  saveRecogConfig(recogConfig('claude'));
  assert.equal(recogConfig().key, 'test-claude-key');
  assert.equal(recogConfig().model, 'claude-opus-5-5');
  saveRecogConfig(recogConfig('openai'));
  assert.equal(recogConfig().key, 'test-openai-key');
  assert.equal(recogConfig().model, 'gpt-5.4');
});

test('invalid saved settings fall back safely and never enable a provider without its own key', async () => {
  for (const raw of ['null', 'invalid JSON', JSON.stringify({ provider: 'unknown', key: 42 })]) {
    localStorage.setItem('margin.recog', raw);
    assert.equal(recogConfig().provider, 'claude');
    assert.equal(recogReady(), false);
    await assert.rejects(recognize('AA==', 'latex'), /Add your API key/);
  }
  localStorage.setItem('margin.recog', JSON.stringify({ provider: 'openai', claude: { key: 'test-claude-key' }, openai: { model: 'claude-opus-5-5' } }));
  assert.equal(recogConfig().model, 'gpt-5.4-mini');
  await assert.rejects(recognize('AA==', 'latex'), /Add your API key/);
});

test('OpenAI receives only the selection PNG, prompt and its own key, and returns clean LaTeX', async () => {
  saveRecogConfig({ provider: 'claude', key: 'test-claude-key', model: 'claude-sonnet-5-5' });
  useOpenAI();
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init, body: JSON.parse(init.body) };
    return Response.json(reply('```latex\n\\[ x^2 + y^2 = 1 \\]\n```'));
  };
  assert.equal(await recognize('AA==', 'latex'), 'x^2 + y^2 = 1');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.Authorization, 'Bearer test-openai-key');
  assert.equal(request.headers['x-api-key'], undefined);
  assert.equal(JSON.stringify(request).includes('test-claude-key'), false);
  assert.equal(request.body.model, 'gpt-5.4-mini');
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' });
  assert.match(request.body.input[0].content[1].text, /handwritten mathematics/);
});

test('OpenAI text keeps line breaks and inline math; all assistant text parts are read', async () => {
  useOpenAI();
  globalThis.fetch = async (_url, init) => {
    assert.match(JSON.parse(init.body).input[0].content[1].text, /plain text/);
    const data = reply('First line with $x^2$');
    data.output[1].content.push({ type: 'output_text', text: 'Second line' });
    return Response.json(data);
  };
  assert.equal(await recognize('AA==', 'text'), 'First line with $x^2$\nSecond line');
});

test('Claude still uses its existing image API and cleans LaTeX delimiters', async () => {
  saveRecogConfig({ provider: 'claude', key: 'test-claude-key', model: 'claude-haiku-5-5' });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'test-claude-key');
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.messages[0].content[0].source.data, 'AA==');
    return Response.json({ content: [{ type: 'text', text: '$$a+b$$' }] });
  };
  assert.equal(await recognize('AA==', 'latex'), 'a+b');
});

test('API errors, refusals, empty and truncated responses never become a formula', async () => {
  useOpenAI();
  for (const [data, status, message] of [
    [{ error: { message: 'secret server detail' } }, 401, /API key was rejected/],
    [{ error: { message: 'Quota exceeded' } }, 429, /Quota exceeded/],
    [{ error: { message: 'Model unavailable' }, status: 'failed' }, 200, /Model unavailable/],
    [{ ...reply('x^'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 200, /cut off/],
    [{ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot transcribe' }] }] }, 200, /could not transcribe/],
    [reply('   '), 200, /returned nothing/],
  ]) {
    globalThis.fetch = async () => Response.json(data, { status });
    await assert.rejects(recognize('AA==', 'latex'), message);
  }
});
