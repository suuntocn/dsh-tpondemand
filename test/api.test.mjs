import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TpClient } from '../src/client.mjs';
import { TpApi, parseCatalog } from '../src/api.mjs';
import { ApiChangeService } from '../src/api-changes.mjs';

const origin = 'https://example.tpondemand.com';
const resources = { UserStories: 'UserStory', Tasks: 'Task', Projects: 'Project', Comments: 'Comment', Attachments: 'Attachment', KeyResults: 'KeyResult', TestPlans: 'TestPlan', Users: 'User' };
const catalog = `<ResourceMetadata>${Object.entries(resources).map(([resource, name]) => `<ResourceMetadataDescription Name="${name}" Uri="${origin}/api/v1/${resource}/meta" Description="A &amp; B" />`).join('')}</ResourceMetadata>`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture() {
  const data = new Map([['UserStories/11', { Id: 11, Name: 'Before', Project: { Id: 1 }, ModifyDate: 'v1', EntityState: { Id: 1, Name: 'Open', NextStates: { Items: [{ Id: 2, Name: 'In Progress' }] } } }],
    ['Tasks/12', { Id: 12, Name: 'Task', Project: { Id: 1 } }], ['TestPlans/1', { Id: 1, Name: 'Plan', TestCases: { Items: [{ Id: 10 }] } }]]);
  const calls = [], bytesById = new Map();
  let nextId = 100, hook;
  const client = new TpClient({ origin, token: 'test-secret', sleep: async () => {}, fetchImpl: async (url, options) => {
    const path = url.pathname.replace('/api/v1/', '');
    calls.push({ url, method: options.method, body: options.body });
    if (hook) { const answer = await hook(url, options, path); if (answer) return answer; }
    if (path === 'Index/meta') return new Response(catalog);
    if (path.endsWith('/meta')) return json({ Name: resources[path.split('/')[0]], CanCreate: true, CanUpdate: true, CanDelete: true,
      ResourceMetadataPropertiesDescription: { values: { Items: [
        ...['Id', 'Name', 'Project', 'Description', 'EntityState', 'General', 'CustomFields', 'TestCases'].map(Name => ({ Name, CanSet: true, CanGet: true, IsRequired: Name === 'Name' })),
        { Name: 'ModifyDate', CanSet: false, CanGet: true },
      ] } } });
    if (url.pathname === '/UploadFile.ashx') {
      for (const [, file] of options.body.entries()) if (typeof file !== 'string') {
        const Id = nextId++; const bytes = Buffer.from(await file.arrayBuffer()); bytesById.set(Id, bytes);
        data.set(`Attachments/${Id}`, { Id, Name: file.name, Size: bytes.length, General: { Id: Number(options.body.get('generalId')) } });
      }
      return new Response('<UploadResult Success="true"/>');
    }
    if (url.pathname === '/Attachment.aspx') return new Response(bytesById.get(Number(url.searchParams.get('AttachmentID'))));
    if (options.method === 'GET') {
      if (/\/\d+$/.test(path)) return data.has(path) ? json(data.get(path)) : json({}, 404);
      const rows = [...data].filter(([key]) => key.startsWith(path + '/')).map(([, row]) => row);
      return json({ Items: rows });
    }
    const body = options.body ? JSON.parse(options.body) : undefined;
    const mutate = (key, value, method) => {
      if (method === 'DELETE') { data.delete(key); return null; }
      const row = { ...data.get(key), ...value, Id: Number(key.split('/').at(-1)) };
      data.set(key, row); return row;
    };
    if (path.endsWith('/bulk')) return json({ Items: body.map(row => mutate(`${path.split('/')[0]}/${row.Id ?? nextId++}`, row, options.method)) });
    if (/\/\d+$/.test(path)) {
      const result = mutate(path, body, options.method);
      return options.method === 'DELETE' ? new Response(null, { status: 200 }) : json(result);
    }
    return json(mutate(`${path}/${nextId++}`, body, options.method), 201);
  } });
  return { client, api: new TpApi(client), data, calls, setHook: value => { hook = value; } };
}
async function service(t, f = fixture()) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tp-api-test-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { ...f, stateDir, service: new ApiChangeService(f.api, { stateDir }) };
}

test('XML catalog preserves all entries, decodes descriptions and ignores external/credential URIs', () => {
  const xml = catalog.replace('</ResourceMetadata>', '<ResourceMetadataDescription Name="Bad" Uri="https://evil.test/api/v1/Bad/meta"/><ResourceMetadataDescription Name="Authentication" Uri="https://example.tpondemand.com/api/v1/Authentication/meta"/></ResourceMetadata>');
  assert.equal(parseCatalog(xml, origin).length, Object.keys(resources).length);
  assert.equal(parseCatalog(xml, origin)[0].description, 'A & B');
  assert.throws(() => parseCatalog('<!DOCTYPE X><ResourceMetadata/>', origin), { code: 'INVALID_METADATA' });
});

test('all tenant entities resolve singular/plural and custom aliases, cache can refresh', async () => {
  const f = fixture();
  assert.equal((await f.api.resolve('UserStory')).resource, 'UserStories');
  assert.equal((await f.api.resolve('keyresults')).name, 'KeyResult');
  await assert.rejects(f.api.resolve('Nonexistent'), { code: 'UNKNOWN_RESOURCE' });
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('Index/meta')).length, 1);
  await f.api.catalog(true); assert.equal(f.calls.filter(c => c.url.pathname.endsWith('Index/meta')).length, 2);
  assert.equal((await f.api.metadata('UserStory')).CanCreate, true);
});

test('generic query paginates v1/v2 without following Next URLs, rejects partial allPages', async () => {
  const f = fixture();
  f.setHook(async url => {
    if (!url.pathname.endsWith('/UserStories')) return;
    const skip = Number(url.searchParams.get('skip'));
    return skip === 0 ? json({ Items: [{ Id: 1 }], Next: 'https://evil.test/?token=secret' }) : json({ Items: [{ Id: 2 }] });
  });
  assert.deepEqual((await f.api.query({ entityType: 'UserStory', allPages: true })).items.map(r => r.Id), [1, 2]);
  await assert.rejects(f.api.query({ entityType: 'UserStory', allPages: true, maxItems: 1 }), { code: 'PAGE_LIMIT' });
  await assert.rejects(f.api.query({ entityType: 'UserStory', params: { take: 5 } }), { code: 'INVALID_PARAMETER' });
  assert.ok(f.calls.every(c => c.url.origin === origin));
});

test('v2 selectors/aggregates and both history APIs have explicit read-only routes', async () => {
  const f = fixture();
  f.setHook(async url => url.pathname.startsWith('/api/v2/') || url.pathname.startsWith('/api/history/') ? json({ result: 42 }) : undefined);
  assert.deepEqual((await f.api.query({ version: 'v2', entityType: 'UserStory', params: { result: 'Count()' } })).result, { result: 42 });
  await f.api.get({ version: 'v2', path: 'UserStoryHistories', params: { select: '{id,name}' } });
  await f.api.get({ version: 'history/v2', path: 'UserStory' });
  assert.ok(f.calls.some(c => c.url.pathname === '/api/v2/UserStoryHistories'));
  assert.ok(f.calls.some(c => c.url.pathname === '/api/history/v2/UserStory'));
  await assert.rejects(f.client.apiRequest({ version: 'v2', path: 'UserStory/11', method: 'DELETE' }), { code: 'READ_ONLY_RESOURCE' });
});

test('credentials cannot escape to arbitrary paths, reserved params, redirects, outputs or keys', async () => {
  const f = fixture();
  for (const path of ['https://evil.test', '../Users', 'Users%2f11', 'Users/11?x=y', 'Users\\11', 'Authentication']) {
    await assert.rejects(f.api.get({ path }));
  }
  for (const key of ['access_token', 'TOKEN', 'callback', '_method', 'format', 'resultFormat', 'redirect']) {
    await assert.rejects(f.client.apiRequest({ path: 'UserStories', params: { [key]: 'x' } }), { code: 'INVALID_PARAMETER' });
  }
  assert.equal(JSON.stringify(f.client.sanitize({ 'test-secret': 'test-secret', password: 'another' })).includes('test-secret'), false);
});

test('Story create, update custom fields and delete with empty 200 are previewed and read back', async t => {
  const f = await service(t);
  const created = await f.service.preview({ requests: [{ method: 'POST', path: 'UserStories', body: { Name: 'New', Project: { Id: 1 } } }] });
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal((await f.service.apply(created.planId)).verified, 1);
  const updated = await f.service.preview({ requests: [{ method: 'POST', path: 'UserStory/11', body: { CustomFields: [{ Name: 'Budget', Value: 4 }] } }] });
  assert.equal((await f.service.apply(updated.planId)).verified, 1);
  const deleted = await f.service.preview({ requests: [{ method: 'DELETE', path: 'UserStories/11' }] });
  assert.equal((await f.service.apply(deleted.planId)).verified, 1);
  assert.equal(f.data.has('UserStories/11'), false);
});

test('readonly/unknown fields, missing fields, ID injection, unsafe bulk and invalid transitions fail before writing', async t => {
  const f = await service(t);
  for (const request of [
    { method: 'POST', path: 'UserStories', body: { Id: 11, Name: 'bad' } },
    { method: 'POST', path: 'UserStories', body: { Project: { Id: 1 } } },
    { method: 'POST', path: 'UserStories/11', body: { ModifyDate: 'bad' } },
    { method: 'POST', path: 'UserStories/11', body: { Unknown: 'bad' } },
    { method: 'POST', path: 'UserStories/11', body: { Id: 12 } },
    { method: 'POST', path: 'UserStories/11', body: { EntityState: { Id: 99 } } },
    { method: 'DELETE', path: 'UserStories' },
    { method: 'DELETE', path: 'UserStories/bulk', body: [{ Id: 11, Name: 'bad' }] },
    { method: 'POST', path: 'UserStories/bulk', body: [{ Id: 11 }, { Id: 11 }] },
    { method: 'POST', path: 'UserStories/meta', body: {} },
  ]) await assert.rejects(f.service.preview({ requests: [request] }));
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
});

test('workflow updates use allowed actual IDs and reject truncated next states', async t => {
  const f = await service(t);
  const plan = await f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { EntityState: { Id: 2 } } }] });
  assert.equal((await f.service.apply(plan.planId)).verified, 1);
  f.data.get('UserStories/11').EntityState = { Id: 1, NextStates: { Next: true, Items: [{ Id: 2 }] } };
  await assert.rejects(f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { EntityState: { Id: 2 } } }] }), { code: 'WORKFLOW_TRUNCATED' });
});

test('bulk mixed create/update and delete preserve per-entity verification', async t => {
  const f = await service(t);
  const plan = await f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/bulk', body: [{ Id: 11, Name: 'Changed' }, { Name: 'New' }] }] });
  const report = await f.service.apply(plan.planId);
  assert.equal(report.verified, 1); assert.equal(report.results[0].verification.checks.length, 2);
  const deletion = await f.service.preview({ requests: [{ method: 'DELETE', path: 'UserStories/bulk', body: [{ Id: 11 }, { Id: 100 }] }] });
  assert.equal((await f.service.apply(deletion.planId)).verified, 1);
});

test('entity drift, consumed/expired plans and shared locks prevent unintended replay', async t => {
  const f = await service(t);
  const request = { method: 'POST', path: 'UserStories/11', body: { Name: 'Change' } };
  const plan = await f.service.preview({ requests: [request] });
  f.data.get('UserStories/11').Name = 'Externally changed';
  assert.equal((await f.service.apply(plan.planId)).results[0].error.code, 'ENTITY_CHANGED');
  await assert.rejects(f.service.apply(plan.planId), { code: 'PLAN_USED' });
  const expiring = new ApiChangeService(f.api, { stateDir: f.stateDir, now: () => 1 });
  const p = await expiring.preview({ requests: [request] }); expiring.now = () => 700000;
  await assert.rejects(expiring.apply(p.planId), { code: 'PLAN_EXPIRED' });
  const next = await f.service.preview({ requests: [request] });
  const key = (await import('node:crypto')).createHash('sha256').update(origin).digest('hex');
  await writeFile(join(f.stateDir, `${key}.lock`), 'other');
  await assert.rejects(f.service.apply(next.planId), { code: 'BATCH_BUSY' });
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
});

test('uncertain create survives service restart and cannot be replayed; uncertain update recovers by readback', async t => {
  const f = await service(t);
  let creates = 0;
  f.setHook(async (url, options, path) => {
    if (options.method === 'POST' && path === 'UserStories') { creates++; throw new Error('lost response'); }
  });
  const request = { method: 'POST', path: 'UserStories', body: { Name: 'Maybe created' } };
  const p = await f.service.preview({ requests: [request] });
  assert.equal((await f.service.apply(p.planId)).results[0].outcome, 'write_uncertain');
  const restarted = new ApiChangeService(f.api, { stateDir: f.stateDir });
  const p2 = await restarted.preview({ requests: [request] });
  assert.equal((await restarted.apply(p2.planId)).results[0].error.code, 'WRITE_PENDING'); assert.equal(creates, 1);
  f.setHook(async (url, options, path) => {
    if (options.method === 'POST' && path === 'UserStories/11') { Object.assign(f.data.get(path), JSON.parse(options.body)); throw new Error('response lost after commit'); }
  });
  const update = await f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { Name: 'Recovered' } }] });
  assert.equal((await f.service.apply(update.planId)).results[0].outcome, 'verified_after_uncertain_write');
});

test('definite rejections release intent, DELETE 5xx is uncertain and never retried', async t => {
  const f = await service(t);
  f.setHook(async (url, options) => options.method !== 'GET' ? json({}, 403) : undefined);
  const p = await f.service.preview({ requests: [{ method: 'DELETE', path: 'UserStories/11' }] });
  assert.equal((await f.service.apply(p.planId)).results[0].error.code, 'AUTH_OR_PERMISSION');
  assert.equal((await readdir(f.stateDir)).filter(n => n.endsWith('.pending')).length, 0);
  f.setHook(async (url, options) => options.method === 'DELETE' ? json({}, 503) : undefined);
  const next = await f.service.preview({ requests: [{ method: 'DELETE', path: 'UserStories/11' }] });
  assert.equal((await f.service.apply(next.planId)).results[0].outcome, 'write_uncertain');
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 2);
});

test('nested unassign is explicitly unverified and undelete is supported for Project/User only', async t => {
  const f = await service(t);
  f.setHook(async (url, options, path) => {
    if (path === 'TestPlans/1/TestCases/10' && options.method === 'DELETE') return new Response(null);
    if (path === 'Undelete' && options.method === 'POST') { f.data.set('Projects/8', { Id: 8 }); return new Response(null); }
  });
  const p = await f.service.preview({ requests: [{ method: 'DELETE', path: 'TestPlans/1/TestCases/10' }] });
  assert.equal((await f.service.apply(p.planId)).results[0].outcome, 'accepted_unverified');
  const restore = await f.service.preview({ requests: [{ method: 'POST', path: 'Undelete', body: { entityType: 'Project', id: 8 } }] });
  assert.equal((await f.service.apply(restore.planId)).verified, 1);
  await assert.rejects(f.service.preview({ requests: [{ method: 'POST', path: 'Undelete', body: { entityType: 'UserStory', id: 11 } }] }));
});

test('upload uses immutable bytes, handles XML receipt, verifies attachment ownership and SHA256', async t => {
  const f = await service(t); const file = join(f.stateDir, 'evidence.txt'); await writeFile(file, 'verified bytes');
  const p = await f.service.previewUpload({ entityType: 'UserStory', entityId: 11, filePaths: [file] });
  assert.equal(p.requests[0].files[0].size, 14);
  await writeFile(file, 'changed locally after preview');
  assert.equal((await f.service.apply(p.planId)).verified, 1);
  const downloaded = await f.client.downloadAttachment(100, 11); assert.equal(downloaded.bytes.toString(), 'verified bytes');
  await assert.rejects(f.client.downloadAttachment(100, 12), { code: 'ATTACHMENT_MISMATCH' });
  const report = await readFile(join(f.stateDir, `api-report-${p.planId}.json`), 'utf8'); assert.equal(report.includes('test-secret'), false);
});

test('write-only fields can be sent without reading secrets or claiming full verification', async t => {
  const f = await service(t);
  f.setHook(async (url, options, path) => {
    if (path === 'Users/meta') return json({ CanCreate: true, CanUpdate: true, CanDelete: true,
      ResourceMetadataPropertiesDescription: { Items: [{ Name: 'Id', CanGet: true, CanSet: true }, { Name: 'Password', CanGet: false, CanSet: true }] } });
    if (path === 'Users/8') {
      if (options.method === 'GET') { assert.equal(url.searchParams.get('include').includes('Password'), false); return json({ Id: 8 }); }
      return json({ Id: 8 });
    }
  });
  const p = await f.service.preview({ requests: [{ method: 'POST', path: 'Users/8', body: { Password: 'placeholder-secret' } }] });
  assert.equal(JSON.stringify(p).includes('placeholder-secret'), false);
  const report = await f.service.apply(p.planId);
  assert.equal(report.results[0].outcome, 'accepted_unverified');
  assert.equal(JSON.stringify(report).includes('placeholder-secret'), false);
});

test('tenant CRUD flags are respected and independent batch failures preserve actual results', async t => {
  const f = await service(t);
  f.setHook(async (url, options, path) => {
    if (path === 'KeyResults/meta') return json({ CanCreate: false, CanUpdate: false, CanDelete: false });
    if (path === 'Tasks/12' && options.method === 'POST') return json({}, 403);
  });
  await assert.rejects(f.service.preview({ requests: [{ method: 'POST', path: 'KeyResult', body: { Name: 'blocked' } }] }), { code: 'OPERATION_NOT_SUPPORTED' });
  const p = await f.service.preview({ requests: [
    { method: 'POST', path: 'Tasks/12', body: { Name: 'Rejected' } },
    { method: 'POST', path: 'UserStories/11', body: { Name: 'Accepted' } },
  ] });
  const report = await f.service.apply(p.planId);
  assert.equal(report.verified, 1);
  assert.equal(report.results[0].error.code, 'AUTH_OR_PERMISSION');
  assert.equal(report.results[1].outcome, 'verified');
});

test('applied plans keep blocking replay but no longer use one of the 10 pending slots', async t => {
  const f = await service(t);
  const request = { method: 'POST', path: 'UserStories/11', body: { Name: 'Change' } };
  for (let i = 0; i < 12; i++) {
    const plan = await f.service.preview({ requests: [{ ...request, body: { Name: `Change ${i}` } }] });
    assert.equal((await f.service.apply(plan.planId)).verified, 1);
    await assert.rejects(f.service.apply(plan.planId), { code: 'PLAN_USED' });
  }
  for (let i = 0; i < 10; i++) await f.service.preview({ requests: [request] });
  await assert.rejects(f.service.preview({ requests: [request] }), { code: 'PLAN_LIMIT' });
});

test('apply reuses metadata younger than a plan lifetime and refetches older metadata', async t => {
  let clock = 1_000_000;
  const f = fixture();
  f.api.now = () => clock;
  const stateDir = await mkdtemp(join(tmpdir(), 'tp-api-test-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const svc = new ApiChangeService(f.api, { stateDir, now: () => clock });
  const metaCalls = () => f.calls.filter(c => c.url.pathname.endsWith('UserStories/meta')).length;
  const p1 = await svc.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { Name: 'A' } }] });
  assert.equal(metaCalls(), 1);
  assert.equal((await svc.apply(p1.planId)).verified, 1);
  assert.equal(metaCalls(), 1, 'fresh metadata is reused on apply');
  const p2 = await svc.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { Name: 'B' } }] });
  clock += 600001;
  svc.now = () => clock - 1000; // plan still valid, metadata now older than the limit
  assert.equal((await svc.apply(p2.planId)).verified, 1);
  assert.equal(metaCalls(), 2, 'stale metadata is refetched on apply');
});

test('state change reads current state and allowed transitions in one entity request', async t => {
  const f = await service(t);
  const entityReads = () => f.calls.filter(c => c.method === 'GET' && c.url.pathname.endsWith('UserStories/11')).length;
  const plan = await f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { EntityState: { Id: 2 } } }] });
  assert.equal(entityReads(), 1);
  assert.equal(plan.requests[0].targets[0].before.EntityState.Id, 1);
  assert.equal(f.calls.find(c => c.method === 'GET' && c.url.pathname.endsWith('UserStories/11')).url.searchParams.get('include').includes('NextStates'), true);
  await assert.rejects(f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { EntityState: { Id: 9 } } }] }), { code: 'INVALID_TRANSITION' });
  f.data.get('UserStories/11').EntityState.NextStates.Next = 'more';
  await assert.rejects(f.service.preview({ requests: [{ method: 'POST', path: 'UserStories/11', body: { EntityState: { Id: 2 } } }] }), { code: 'WORKFLOW_TRUNCATED' });
  delete f.data.get('UserStories/11').EntityState.NextStates.Next;
  const before = entityReads();
  assert.equal((await f.service.apply(plan.planId)).verified, 1);
  assert.equal(entityReads() - before, 2, 'apply: one drift+transition read, one read-back');
});
