import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BugChangeService, hasComment } from '../src/changes.mjs';
import { TpError } from '../src/client.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tp-changes-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const bug = { Id: 12, Name: 'Bug 12', EntityState: { Id: 10, Name: 'New', NextStates: { Items: [{ Id: 20, Name: 'In Progress' }, { Id: 30, Name: 'Invalid' }] } } };
  const comments = [];
  const writes = [];
  const client = { origin: 'https://example.tpondemand.com', getBug: async () => structuredClone(bug),
    comments: async () => structuredClone(comments),
    setState: async (id, stateId) => { writes.push(['state', id]); bug.EntityState = { ...bug.EntityState, Id: stateId, Name: stateId === 20 ? 'In Progress' : 'Invalid' }; },
    addComment: async (id, Description) => { writes.push(['comment', id]); comments.push({ Id: 1, Description }); } };
  return { service: new BugChangeService(client, { stateDir }), client, bug, comments, writes, stateDir };
}

test('standalone state change needs no MR/comment; preview is read only and repeat apply is idempotent', async t => {
  const f = await fixture(t);
  const plan = await f.service.preview({ changes: [{ bugId: 12, expectedState: 'New', targetState: 'In Progress' }] });
  assert.deepEqual(f.writes, []);
  assert.equal((await f.service.apply(plan.planId)).succeeded, 1);
  assert.deepEqual(f.writes, [['state', 12]]);
  assert.equal((await f.service.apply(plan.planId)).succeeded, 1);
  assert.equal(f.writes.length, 1);
});

test('comment-only delivery preserves full build details, escapes HTML and deduplicates full text', async t => {
  const f = await fixture(t);
  const text = 'Fix: <MR>\nBuild: #19\nCommit: abc123';
  const plan = await f.service.preview({ changes: [{ bugId: 12, comment: text }] });
  assert.equal(plan.results[0].request.comment, text);
  assert.equal((await f.service.apply(plan.planId)).succeeded, 1);
  assert.equal(f.bug.EntityState.Name, 'New');
  assert.match(f.comments[0].Description, /&lt;MR&gt;/);
  await f.service.apply(plan.planId);
  assert.equal(f.writes.length, 1);
  const next = await f.service.preview({ changes: [{ bugId: 12, comment: text.replace('#19', '#20') }] });
  await f.service.apply(next.planId);
  assert.equal(f.writes.length, 2);
  assert.ok(!hasComment(f.comments, 'Fix: <MR>'));
});

test('duplicate IDs, unavailable or ambiguous workflow targets cannot mutate data', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.preview({ changes: [{ bugId: 12, comment: 'a' }, { bugId: 12, comment: 'b' }] }), { code: 'DUPLICATE_BUG' });
  for (const targetState of ['In Testing', 'Invalid']) {
    if (targetState === 'Invalid') f.bug.EntityState.NextStates.Items.push({ Id: 99, Name: 'Invalid' });
    const plan = await f.service.preview({ changes: [{ bugId: 12, targetState, comment: 'not posted' }] });
    assert.equal(plan.blocked, 1);
    await f.service.apply(plan.planId);
  }
  assert.deepEqual(f.writes, []);
});

test('comment-only plans block external status drift; expired plans cannot write', async t => {
  const f = await fixture(t);
  const plan = await f.service.preview({ changes: [{ bugId: 12, comment: 'Investigated' }] });
  f.bug.EntityState.Id = 40; f.bug.EntityState.Name = 'Closed';
  assert.equal((await f.service.apply(plan.planId)).skipped, 1);
  f.service.now = () => Date.now() + 11 * 60 * 1000;
  await assert.rejects(f.service.apply(plan.planId), { code: 'PLAN_EXPIRED' });
  assert.deepEqual(f.writes, []);
});

test('accepted state/comment with lost responses recover by readback without repeat writes', async t => {
  const f = await fixture(t);
  const set = f.client.setState; const add = f.client.addComment;
  f.client.setState = async (...args) => { await set(...args); throw new TpError('WRITE_UNCERTAIN', 'timeout'); };
  f.client.addComment = async (...args) => { await add(...args); throw new TpError('WRITE_UNCERTAIN', 'timeout'); };
  const plan = await f.service.preview({ changes: [{ bugId: 12, targetState: 'Invalid', comment: 'Reference: iOS\nConclusion: matches reference' }] });
  const result = await f.service.apply(plan.planId);
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[0].state, 'updated_and_recovered');
  assert.equal(result.results[0].comment, 'added_and_recovered');
  assert.deepEqual(f.writes, [['state', 12], ['comment', 12]]);
});

test('uncertain comment failure persists across services and prevents blind resending', async t => {
  const f = await fixture(t);
  f.client.addComment = async () => { f.writes.push(['comment', 12]); throw new TpError('WRITE_UNCERTAIN', 'timeout'); };
  const request = { changes: [{ bugId: 12, comment: 'A complete comment' }] };
  assert.equal((await f.service.apply((await f.service.preview(request)).planId)).failed, 1);
  const restarted = new BugChangeService(f.client, { stateDir: f.stateDir });
  const second = await restarted.apply((await restarted.preview(request)).planId);
  assert.equal(second.results[0].error.code, 'COMMENT_UNCERTAIN');
  assert.equal(f.writes.length, 1);
});

test('definite comment rejection permits retry, while state failure suppresses misleading comment', async t => {
  const f = await fixture(t);
  const add = f.client.addComment;
  f.client.addComment = async () => { throw new TpError('HTTP_403', 'rejected'); };
  const request = { changes: [{ bugId: 12, comment: 'Build available' }] };
  assert.equal((await f.service.apply((await f.service.preview(request)).planId)).failed, 1);
  f.client.addComment = add;
  assert.equal((await f.service.apply((await f.service.preview(request)).planId)).succeeded, 1);
  f.client.setState = async () => { throw new TpError('HTTP_409', 'conflict'); };
  const failed = await f.service.apply((await f.service.preview({ changes: [{ bugId: 12, targetState: 'Invalid', comment: 'Must not post' }] })).planId);
  assert.equal(failed.failed, 1);
  assert.ok(!hasComment(f.comments, 'Must not post'));
});

test('blocked records do not prevent independent verified changes and retain partial counts', async t => {
  const f = await fixture(t);
  const plan = await f.service.preview({ changes: [{ bugId: 12, targetState: 'In Progress' }, { bugId: 13, comment: 'not posted' }] });
  assert.equal(plan.ready, 1);
  assert.equal(plan.blocked, 1);
  const result = await f.service.apply(plan.planId);
  assert.equal(result.succeeded, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(f.writes, [['state', 12]]);
});
