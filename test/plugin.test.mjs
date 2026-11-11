import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Config, apply } from '../index.js';
import { connectionConfig, createRuntime, toolCatalog, STATE_DIR, requiresApproval, policyDenial } from '../runtime.js';
import { loadConfig } from '../src/config.mjs';

const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const body = result => JSON.parse(result.content[0].text);
const url = 'https://example.tpondemand.com';
const token = 'fake-test-token/a+b';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-tp-plugin-test-'));
  t.after(async () => {
    assert.equal(resolve(stateDir), stateDir);
    assert.ok(stateDir.startsWith(join(tmpdir(), 'dsh-tp-plugin-test-')));
    await rm(stateDir, { recursive: true, force: true });
  });
  let config = connectionConfig(url, token);
  const requests = [];
  const comments = [];
  const bug = { Id: 12, Name: 'Bug', EntityState: { Id: 10, Name: 'New', NextStates: { Items: [{ Id: 20, Name: 'In Progress' }] } } };
  const fetchImpl = async (address, request) => {
    requests.push({ origin: address.origin, token: address.searchParams.get('access_token'), method: request.method });
    if (address.pathname.endsWith('/Users/LoggedUser')) return json({ Id: 1, FirstName: 'Demo' });
    if (address.pathname.endsWith('/Bugs/12')) {
      if (request.method === 'POST') bug.EntityState = { Id: 20, Name: 'In Progress', NextStates: { Items: [] } };
      return json(bug);
    }
    if (address.pathname.endsWith('/Comments')) {
      if (request.method === 'POST') comments.push({ Id: 99, Description: JSON.parse(request.body).Description });
      return json({ Items: comments });
    }
    throw new Error('Unexpected mock route');
  };
  const options = { stateDir, clientOptions: { fetchImpl } };
  const runtime = createRuntime(() => config, options);
  t.after(() => runtime.close());
  return { runtime, options, stateDir, requests, set: next => { config = next; } };
}

test('Config exposes two volatile settings and a secret Token, empty by default', () => {
  const config = Config({});
  assert.deepEqual(Object.keys(config), ['url', 'token']);
  assert.equal(config.url.get(), '');
  assert.equal(config.token.get(), '');
  assert.equal(Config.dict.token.meta.role, 'secret');
  assert.equal(Config.dict.url.meta.volatile, true);
  assert.equal(Config.dict.token.meta.volatile, true);
});

test('native connection validates HTTPS and Token without echoing credential values', () => {
  assert.equal(connectionConfig(` ${url}/api/v1/ `, '  token  ').origin, url);
  assert.equal(connectionConfig(url, '  token  ').token, 'token');
  for (const invalid of ['http://example.com', 'https://name:secret@example.com', `${url}?secret=123`, `${url}/other`, `${url}#abc`]) {
    assert.throws(() => connectionConfig(invalid, token), error => !error.message.includes(token) && !error.message.includes(invalid));
  }
  for (const invalid of ['fake\nsecret', 'fake\0secret', 'a'.repeat(8193)]) {
    assert.throws(() => connectionConfig(url, invalid), error => !error.message.includes(invalid));
  }
});

test('standalone config has no implicit tenant or Keychain fallback', async () => {
  await assert.rejects(loadConfig({}));
  assert.deepEqual(await loadConfig({ TP_BASE_URL: url }), { origin: url, token: undefined, credentialSource: 'not_configured' });
});

test('catalog preserves 34 tools, optional defaults, strict objects and destructive hints', () => {
  const catalog = toolCatalog();
  assert.equal(catalog.length, 34);
  assert.equal(new Set(catalog.map(tool => tool.name)).size, 34);
  const search = catalog.find(tool => tool.name === 'tp_search_bugs');
  assert.ok(!search.inputSchema.required?.includes('limit'));
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(catalog.find(tool => tool.name === 'tp_apply_api_changes').annotations.destructiveHint, true);
  assert.equal(catalog.find(tool => tool.name === 'tp_connection_status').annotations.readOnlyHint, true);
});

test('unconfigured calls report setup without network or inherited credentials', async () => {
  const runtime = createRuntime(() => connectionConfig('', ''), { clientOptions: { fetchImpl: () => assert.fail('network') } });
  assert.equal(body(await runtime.call('tp_connection_status', {})).connected, false);
  await assert.rejects(runtime.call('tp_get_bug', { bugId: 12 }), /插件/);
  await runtime.close();
});

test('configured status and credentials switch take effect on the next call', async t => {
  const f = await fixture(t);
  assert.equal(body(await f.runtime.call('tp_connection_status', {})).connected, true);
  f.set(connectionConfig('https://second.example', 'second-fake-token'));
  await f.runtime.call('tp_connection_status', {});
  assert.deepEqual(f.requests.map(({ origin, token }) => ({ origin, token })), [
    { origin: url, token }, { origin: 'https://second.example', token: 'second-fake-token' },
  ]);
  f.set(connectionConfig(url, ''));
  assert.equal(body(await f.runtime.call('tp_connection_status', {})).connected, false);
  assert.equal(f.requests.length, 2);
});

test('Zod validation blocks invalid inputs and refinements before network', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['tp_get_bug', { bugId: -1 }],
    ['tp_preview_bug_changes', { changes: [{ bugId: 12 }] }],
    ['tp_search_bugs', { unexpected: 'field' }],
  ]) await assert.rejects(f.runtime.call(name, args), /参数无效/);
  assert.equal(f.requests.length, 0);
});

test('preview/apply retains plan and private state across calls', async t => {
  const f = await fixture(t);
  const preview = body(await f.runtime.call('tp_preview_bug_changes', { changes: [{ bugId: 12, comment: 'Reviewed' }] }));
  assert.ok(preview.planId);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  const result = body(await f.runtime.call('tp_apply_bug_changes', { planId: preview.planId }));
  assert.equal(result.succeeded, 1);
  assert.ok((await readdir(f.stateDir)).some(file => file.startsWith('report-')));
  assert.ok(!STATE_DIR.includes('node_modules'));
});

test('connection change invalidates previews rather than sending plans to another tenant', async t => {
  const f = await fixture(t);
  const preview = body(await f.runtime.call('tp_preview_bug_changes', { changes: [{ bugId: 12, comment: 'Reviewed' }] }));
  f.set(connectionConfig('https://second.example', token));
  const result = await f.runtime.call('tp_apply_bug_changes', { planId: preview.planId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PLAN_EXPIRED/);
  assert.ok(f.requests.every(request => request.method === 'GET' && request.origin === url));
});

test('independent runtimes cannot consume another caller preview', async t => {
  const f = await fixture(t);
  const preview = body(await f.runtime.call('tp_preview_bug_changes', { changes: [{ bugId: 12, comment: 'Reviewed' }] }));
  const other = createRuntime(() => connectionConfig(url, token), f.options);
  const result = await other.call('tp_apply_bug_changes', { planId: preview.planId });
  assert.match(result.content[0].text, /PLAN_EXPIRED/);
  await other.close();
});

test('runtime sanitizes encoded credentials in attachment text without changing image bytes', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=', 'base64');
  let imageMode = false;
  const fetchImpl = async address => address.pathname.startsWith('/api/')
    ? json({ Id: 7, Name: imageMode ? 'pixel.png' : 'note.txt', General: { Id: 12 } })
    : new Response(imageMode ? image : `echo ${encodeURIComponent(token)}`, { headers: { 'Content-Type': imageMode ? 'image/png' : 'text/plain' } });
  const runtime = createRuntime(() => connectionConfig(url, token), { clientOptions: { fetchImpl } });
  const text = await runtime.call('tp_read_entity_attachment', { entityId: 12, attachmentId: 7 });
  assert.ok(!JSON.stringify(text).includes(encodeURIComponent(token)));
  assert.match(text.content[0].text, /REDACTED/);
  imageMode = true;
  const output = await runtime.call('tp_read_attachment', { bugId: 12, attachmentId: 7 });
  assert.equal(output.content.find(block => block.type === 'image').data, image.toString('base64'));
  await runtime.close();
});

test('cancellation before entry prevents requests, and close drains admitted work', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = createRuntime(() => connectionConfig(url, token), { clientOptions: { fetchImpl: async () => {
    started(); await gate; return json({ Id: 1 });
  } } });
  await assert.rejects(runtime.call('tp_connection_status', {}, AbortSignal.abort()), /取消/);
  const operation = runtime.call('tp_connection_status', {});
  await entered;
  let closed = false;
  const close = runtime.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  await assert.rejects(runtime.call('tp_connection_status', {}), /取消/);
  release();
  await operation;
  await close;
  assert.equal(closed, true);
});

test('file and mutation tools have explicit fail-closed permission classification', () => {
  for (const name of ['tp_apply_api_changes', 'tp_apply_bug_changes', 'tp_apply_mr_handoff', 'tp_download_attachment', 'tp_preview_attachment_upload']) assert.ok(requiresApproval(name));
  assert.equal(requiresApproval('tp_get_bug'), false);
  assert.ok(policyDenial('tp_preview_attachment_upload', { mode: 'workspace-write' }));
  assert.ok(policyDenial('tp_download_attachment', { mode: 'read-only' }));
  assert.ok(policyDenial('tp_apply_api_changes', { mode: 'read-only' }));
  assert.equal(policyDenial('tp_get_bug', { mode: 'read-only' }), undefined);
  assert.equal(policyDenial('tp_download_attachment', { mode: 'danger-full-access' }), undefined);
});

function hostFixture(config = Config({})) {
  const tools = new Map();
  const effects = [];
  let approval;
  const ctx = {
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    effect: callback => { const disposer = callback(); effects.push(disposer); return disposer; },
    inject: () => {}, get: key => key === 'approval' ? approval : undefined,
  };
  return { ctx, tools, effects, config, setApproval: next => { approval = next; } };
}

test('Host registers native MCP definitions and denies protected direct execution without approval', async () => {
  const f = hostFixture();
  await apply(f.ctx, f.config);
  assert.equal(f.tools.size, 34);
  const signal = new AbortController().signal;
  const status = await f.tools.get('mcp__targetprocess__tp_connection_status').execute({}, { signal });
  assert.equal(body(status).connected, false);
  await assert.rejects(f.tools.get('mcp__targetprocess__tp_download_attachment').execute({}, { signal }), /完整文件访问/);
  // Deliberately skip the entire pre-execute waterfall: the executor must still refuse.
  await assert.rejects(f.tools.get('mcp__targetprocess__tp_apply_api_changes').execute({}, { signal, agent: {} }), /用户确认/);
  for (const dispose of f.effects.reverse()) await dispose?.();
  assert.equal(f.tools.size, 0);
});

test('Host approval accepts only allowed-once and never includes the Token', async () => {
  const f = hostFixture(Config({ url, token }));
  await apply(f.ctx, f.config);
  const name = 'mcp__targetprocess__tp_apply_api_changes';
  const exec = { signal: new AbortController().signal, agent: { session: {} }, name, callId: 'test' };
  const args = { planId: '50f3cbe6-2715-4c82-8a77-8586c9707a13' };
  for (const outcome of ['rejected', 'cancelled', 'unavailable', undefined, 'allow']) {
    f.setApproval({ request: async request => {
      assert.ok(!request.reason.includes(token));
      assert.equal(request.toolName, name);
      return outcome;
    } });
    await assert.rejects(f.tools.get(name).execute(args, exec), /未获授权/);
  }
  f.setApproval({ request: async () => 'allowed-once' });
  await assert.rejects(f.tools.get(name).execute(args, exec), /PLAN_EXPIRED/);
  for (const dispose of f.effects.reverse()) await dispose?.();
});

test('Host rejects connection edits during approval and cancels outstanding approval on unload', async () => {
  let currentToken = token;
  const f = hostFixture({ url: { get: () => url }, token: { get: () => currentToken } });
  await apply(f.ctx, f.config);
  const name = 'mcp__targetprocess__tp_apply_api_changes';
  const tool = f.tools.get(name);
  const exec = { signal: new AbortController().signal, agent: { session: {} }, name };
  f.setApproval({ request: async () => { currentToken = 'rotated-fake-token'; return 'allowed-once'; } });
  await assert.rejects(tool.execute({}, exec), /配置在确认期间/);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.setApproval({ request: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve('cancelled'), { once: true }); entered();
  }) });
  const pending = assert.rejects(tool.execute({}, exec), /未获授权/);
  await ready;
  for (const dispose of f.effects.reverse()) await dispose?.();
  await pending;
  await assert.rejects(tool.execute({}, exec), /abort/i);
});
