import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffService, hasMr, normalizeMr } from '../src/handoff.mjs';
import { TpError } from '../src/client.mjs';

const mrUrl = 'https://gitlab.example.com/team/app/-/merge_requests/7';
const makeBug = (id, state = 'In Progress') => ({ Id: id, Name: `Bug ${id}`, EntityState: { Id: state === 'In Testing' ? 97 : 10, Name: state, NextStates: { Items: [{ Id: 97, Name: 'In Testing' }] } } });

async function fixture(t, ids = [123]) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tp-mcp-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const bugs = new Map(ids.map(id => [id, makeBug(id)]));
  const comments = new Map(ids.map(id => [id, []]));
  const writes = [];
  const client = {
    origin: 'https://example.tpondemand.com',
    getBug: async id => structuredClone(bugs.get(id)),
    comments: async id => structuredClone(comments.get(id)),
    setState: async (id, stateId) => { writes.push(['state', id]); bugs.get(id).EntityState = { Id: stateId, Name: 'In Testing' }; },
    addComment: async (id, description) => { writes.push(['comment', id]); comments.get(id).push({ Id: id + 1, Description: description }); },
  };
  const service = new HandoffService(client, { stateDir });
  const preview = (bugIds = ids) => service.preview({ bugIds, mrUrl });
  return { service, client, bugs, comments, writes, preview, stateDir };
}

test('MR validation and exact URL deduplication avoid matching MR 70 to MR 7', () => {
  assert.equal(normalizeMr(mrUrl + '/'), mrUrl);
  assert.ok(hasMr([{ Description: `<a href="${mrUrl}">${mrUrl}</a>` }], mrUrl));
  assert.ok(!hasMr([{ Description: mrUrl + '0' }], mrUrl));
  for (const bad of ['javascript:alert(1)', 'https://u:p@example.com/a/-/merge_requests/7', mrUrl + '?access_token=x', mrUrl + '#notes']) assert.throws(() => normalizeMr(bad));
});

test('preview is read-only, deduplicates IDs, execution and repeat execution are verified', async t => {
  const f = await fixture(t);
  const plan = await f.preview([123, 123]);
  assert.equal(plan.results.length, 1);
  assert.deepEqual(f.writes, []);
  const result = await f.service.apply(plan.planId);
  assert.equal(result.succeeded, 1);
  assert.deepEqual(f.writes, [['state', 123], ['comment', 123]]);
  assert.equal((await f.service.apply(plan.planId)).succeeded, 1);
  assert.equal(f.writes.length, 2);
});

test('already-target/existing-MR items are not rewritten', async t => {
  const f = await fixture(t);
  f.bugs.set(123, makeBug(123, 'In Testing'));
  f.comments.get(123).push({ Description: 'MR：\n' + mrUrl });
  const result = await f.service.apply((await f.preview()).planId);
  assert.equal(result.results[0].comment, 'already_present');
  assert.deepEqual(f.writes, []);
});

test('unexpected states, ambiguous workflows and per-item failures do not stop other items', async t => {
  const f = await fixture(t, [1, 2, 3, 4]);
  f.bugs.set(1, makeBug(1, 'Reopened'));
  f.bugs.get(2).EntityState.NextStates.Items.push({ Id: 98, Name: 'In Testing' });
  const base = f.client.getBug;
  f.client.getBug = async id => { if (id === 3) throw new TpError('AUTH_OR_PERMISSION', '无权限'); return base(id); };
  const plan = await f.preview();
  assert.equal(plan.blocked, 3);
  const result = await f.service.apply(plan.planId);
  assert.equal(result.succeeded, 1);
  assert.equal(result.skipped, 3);
  assert.deepEqual(f.writes, [['state', 4], ['comment', 4]]);
});

test('reopened after preview is skipped; changed workflow IDs are rejected', async t => {
  const f = await fixture(t, [1, 2]);
  const plan = await f.preview();
  f.bugs.set(1, makeBug(1, 'Reopened'));
  f.bugs.get(2).EntityState.NextStates.Items[0].Id = 98;
  const result = await f.service.apply(plan.planId);
  assert.equal(result.skipped, 2);
  assert.deepEqual(f.writes, []);
});

test('expired plans cannot mutate TP', async t => {
  const f = await fixture(t);
  const plan = await f.preview();
  f.service.now = () => Date.now() + 11 * 60 * 1000;
  await assert.rejects(f.service.apply(plan.planId), { code: 'PLAN_EXPIRED' });
  assert.deepEqual(f.writes, []);
});

test('state POST response lost but readback succeeds: recover without a second POST', async t => {
  const f = await fixture(t);
  const set = f.client.setState;
  f.client.setState = async (...args) => { await set(...args); throw new TpError('WRITE_UNCERTAIN', 'timeout'); };
  const result = await f.service.apply((await f.preview()).planId);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].state, 'updated_and_recovered');
  assert.equal(f.writes.filter(w => w[0] === 'state').length, 1);
});

test('state rejected/unchanged: no misleading MR comment is added', async t => {
  const f = await fixture(t);
  f.client.setState = async () => { throw new TpError('HTTP_409', 'conflict'); };
  const result = await f.service.apply((await f.preview()).planId);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].error.code, 'HTTP_409');
  assert.deepEqual(f.comments.get(123), []);
});

test('comment response lost but server accepted it: recover and deduplicate', async t => {
  const f = await fixture(t);
  const add = f.client.addComment;
  f.client.addComment = async (...args) => { await add(...args); throw new TpError('WRITE_UNCERTAIN', 'timeout'); };
  const result = await f.service.apply((await f.preview()).planId);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].comment, 'added_and_recovered');
  assert.ok((await readdir(f.stateDir)).every(name => name.startsWith('report-')));
});

test('ambiguous comment failure persists across process restart and cannot be blindly replayed', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.client.addComment = async () => { attempts++; throw new TpError('WRITE_UNCERTAIN', 'timeout'); };
  const first = await f.service.apply((await f.preview()).planId);
  assert.equal(first.failed, 1);
  assert.equal(first.results[0].state, 'updated');
  const restarted = new HandoffService(f.client, { stateDir: f.stateDir });
  const plan = await restarted.preview({ bugIds: [123], mrUrl });
  const second = await restarted.apply(plan.planId);
  assert.equal(second.results[0].error.code, 'COMMENT_UNCERTAIN');
  assert.equal(attempts, 1);
  f.comments.get(123).push({ Description: mrUrl });
  assert.equal((await restarted.apply(plan.planId)).succeeded, 1);
  assert.ok((await readdir(f.stateDir)).every(name => name.startsWith('report-')));
});

test('definite comment rejection permits a later successful retry without repeating state changes', async t => {
  const f = await fixture(t);
  const add = f.client.addComment;
  f.client.addComment = async () => { throw new TpError('AUTH_OR_PERMISSION', 'forbidden'); };
  const plan = await f.preview();
  assert.equal((await f.service.apply(plan.planId)).failed, 1);
  f.client.addComment = add;
  assert.equal((await f.service.apply(plan.planId)).succeeded, 1);
  assert.equal(f.writes.filter(w => w[0] === 'state').length, 1);
});

test('concurrent batches are rejected; final externally changed state is not reported successful', async t => {
  const f = await fixture(t);
  const plan = await f.preview();
  const add = f.client.addComment;
  f.client.addComment = async (...args) => {
    await assert.rejects(f.service.apply(plan.planId), { code: 'BATCH_BUSY' });
    await add(...args);
    f.bugs.set(123, makeBug(123, 'Reopened'));
  };
  const result = await f.service.apply(plan.planId);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].comment, 'added');
  assert.equal(result.results[0].error.code, 'FINAL_STATE_CHANGED');
});

test('saved execution reports retain partial outcomes without credential content', async t => {
  const f = await fixture(t);
  const report = await f.service.apply((await f.preview()).planId);
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.equal(saved.results[0].outcome, 'verified');
  assert.equal(saved.results[0].comment, 'added');
  assert.equal(saved.succeeded, 1);
});

test('at most three independent bugs run concurrently and results retain input order', async t => {
  const f = await fixture(t, [1, 2, 3, 4, 5]);
  let active = 0, peak = 0;
  const read = f.client.getBug;
  f.client.getBug = async id => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return read(id);
  };
  const plan = await f.preview();
  assert.equal(peak, 3);
  assert.deepEqual(plan.results.map(r => r.id), [1, 2, 3, 4, 5]);
  assert.equal((await f.service.apply(plan.planId)).succeeded, 5);
  assert.equal(peak, 3);
});
