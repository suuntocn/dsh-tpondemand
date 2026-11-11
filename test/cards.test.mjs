import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectionConfig, createRuntime } from '../runtime.js';
import { renderRichText } from '../src/text.mjs';

const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const body = result => JSON.parse(result.content[0].text);
const url = 'https://example.tpondemand.com';

const card = (id, name) => ({ Id: id, Name: name, EntityState: { Id: 1, Name: 'New' },
  Project: { Id: 9, Name: 'Demo' }, AssignedUser: { Items: [{ Id: 7, FirstName: 'Demo', LastName: 'User' }] },
  ModifyDate: '/Date(1768448940000+0100)/' });

async function fixture(t, { storiesFail = false } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-tp-cards-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const requests = [];
  const fetchImpl = async (address, request) => {
    requests.push({ path: address.pathname, where: address.searchParams.get('where'), method: request.method });
    if (address.pathname.endsWith('/Users/LoggedUser')) return json({ Id: 7, FirstName: 'Demo', LastName: 'User' });
    if (address.pathname.endsWith('/Bugs/12')) {
      return json({ Id: 12, Name: 'A bug', EntityState: { Id: 1, Name: 'New' },
        Description: '<p>Steps to <b>reproduce</b></p><ul><li>one</li><li>two</li></ul><p>&amp; note</p>' });
    }
    if (address.pathname.endsWith('/Bugs')) return json({ Items: [card(1, 'Bug one')] });
    if (address.pathname.endsWith('/UserStories')) {
      if (storiesFail) return new Response('', { status: 400 });
      return json({ Items: [card(2, 'Story two')] });
    }
    if (address.pathname.endsWith('/Tasks')) return json({ Items: [] });
    throw new Error(`Unexpected mock route: ${address.pathname}`);
  };
  const runtime = createRuntime(() => connectionConfig(url, 'fake-test-token'), { stateDir, clientOptions: { fetchImpl } });
  t.after(() => runtime.close());
  return { runtime, requests };
}

test('rich text rendering keeps readable text and drops markup', () => {
  assert.equal(renderRichText('<p>Hello <b>world</b></p><p>Second &amp; third</p>'), 'Hello world\nSecond & third');
  assert.equal(renderRichText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
  assert.equal(renderRichText('plain &amp; simple'), 'plain &amp; simple', 'non-HTML text is left untouched');
  assert.equal(renderRichText(''), '');
});

test('search cards queries each entity type with the requested text field', async t => {
  const f = await fixture(t);
  const any = body(await f.runtime.call('tp_search_cards', { keyword: 'friends' }));
  assert.equal(any.items.length, 2);
  assert.deepEqual(any.items.map(item => item.entityType), ['Bug', 'UserStory']);
  assert.equal(any.items[0].project.name, 'Demo');
  assert.deepEqual(any.items[0].assignees, [{ id: 7, name: 'Demo User' }]);
  assert.equal(any.pages.Bugs.returned, 1);
  const queries = f.requests.filter(r => r.path.endsWith('/Bugs') || r.path.endsWith('/UserStories'));
  assert.deepEqual(queries.map(r => r.where), [
    "Name contains 'friends' or Description contains 'friends'",
    "Name contains 'friends' or Description contains 'friends'",
  ]);

  const named = body(await f.runtime.call('tp_search_cards', { keyword: "O'Brien", field: 'name', entityTypes: ['Bugs'] }));
  assert.equal(named.items[0].name, 'Bug one');
  assert.equal(f.requests.at(-1).where, "Name contains 'O\\'Brien'", 'keyword quotes are escaped');
});

test('search cards reports a failing type without hiding the others', async t => {
  const f = await fixture(t, { storiesFail: true });
  const result = body(await f.runtime.call('tp_search_cards', { keyword: 'friends' }));
  assert.equal(result.items.length, 1);
  assert.equal(result.pages.UserStories.error, 'TP 返回 HTTP 400。');
});

test('my work excludes finished states by default and honours explicit filters', async t => {
  const f = await fixture(t);
  const mine = body(await f.runtime.call('tp_my_work', {}));
  assert.equal(mine.assignee.id, 7);
  assert.deepEqual(mine.items.map(item => item.entityType), ['Bug', 'UserStory']);
  const workQueries = f.requests.filter(r => r.where?.includes('AssignedUser'));
  assert.equal(workQueries.length, 3, 'one query per default entity type');
  assert.deepEqual([...new Set(workQueries.map(r => r.where))], ['AssignedUser.Id eq 7 and EntityState.IsFinal eq \'false\'']);

  body(await f.runtime.call('tp_my_work', { includeFinished: true, entityTypes: ['Bugs'] }));
  assert.equal(f.requests.at(-1).where, 'AssignedUser.Id eq 7');

  body(await f.runtime.call('tp_my_work', { state: 'In Progress', entityTypes: ['Bugs'] }));
  assert.equal(f.requests.at(-1).where, "AssignedUser.Id eq 7 and EntityState.Name eq 'In Progress'");

  body(await f.runtime.call('tp_my_work', { assigneeId: 42, entityTypes: ['Bugs'] }));
  assert.equal(f.requests.at(-1).where, "AssignedUser.Id eq 42 and EntityState.IsFinal eq 'false'");
});

test('bug descriptions reach the model as text, not HTML', async t => {
  const f = await fixture(t);
  const bug = body(await f.runtime.call('tp_get_bug', { bugId: 12 }));
  assert.equal(bug.description, 'Steps to reproduce\n- one\n- two\n& note');
});

test('card tools reject blank keywords before any request', async t => {
  const f = await fixture(t);
  for (const args of [{ keyword: '   ' }, { keyword: 'x', entityTypes: [] }, { keyword: 'x', unexpected: 1 }]) {
    await assert.rejects(f.runtime.call('tp_search_cards', args), /参数无效/);
  }
  assert.equal(f.requests.length, 0);
});
