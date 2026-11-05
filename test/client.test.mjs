import test from 'node:test';
import assert from 'node:assert/strict';
import { TpClient, quote } from '../src/client.mjs';
import { tenantOrigin } from '../src/config.mjs';

const token = 'test-secret-never-log';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const make = fetchImpl => new TpClient({ origin: 'https://example.tpondemand.com', token, fetchImpl, sleep: async () => {} });

test('only HTTPS tenant origins without credentials/query are allowed', () => {
  assert.equal(tenantOrigin('https://example.tpondemand.com/api/v1'), 'https://example.tpondemand.com');
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?token=x', 'https://example.com/other']) assert.throws(() => tenantOrigin(url));
});

test('no token fails before network; arbitrary resources cannot receive credentials', async () => {
  const client = make(() => { throw new Error('must not be called'); });
  await assert.rejects(client.request('https://evil.example'), { code: 'INVALID_PATH' });
  client.token = undefined;
  await assert.rejects(client.getBug(123), { code: 'NOT_CONFIGURED' });
});

test('documented PAT query auth, no redirects, redacted credential and pagination URLs', async () => {
  const client = make(async (url, options) => {
    assert.equal(url.searchParams.get('access_token'), token);
    assert.equal(options.redirect, 'error');
    return json({ Items: [{ Id: 1, Description: token }], Next: `https://evil.example/?access_token=${token}` });
  });
  assert.deepEqual(await client.request('Bugs'), { Items: [{ Id: 1, Description: '[REDACTED]' }], Next: true });
});

test('401/403 errors never return the response body or secret URL', async () => {
  const client = make(async () => json({ Error: token }, 401));
  await assert.rejects(client.currentUser(), error => error.code === 'AUTH_OR_PERMISSION' && !error.message.includes(token));
});

test('GET retries 429 but writes are never automatically retried', async () => {
  let calls = 0;
  const read = make(async () => ++calls === 1 ? json({}, 429, { 'retry-after': '1' }) : json({ Id: 1 }));
  assert.equal((await read.currentUser()).Id, 1);
  assert.equal(calls, 2);
  calls = 0;
  const write = make(async () => { calls++; return json({}, 503); });
  await assert.rejects(write.setState(123, 97), { code: 'WRITE_UNCERTAIN' });
  assert.equal(calls, 1);
});

test('write transport/invalid JSON failures are ambiguous and redact raw network errors', async () => {
  const client = make(async () => { throw new Error(`url?access_token=${token}`); });
  await assert.rejects(client.addComment(123, 'MR'), error => error.code === 'WRITE_UNCERTAIN' && !error.message.includes(token));
  const malformed = make(async () => new Response('<html>login</html>'));
  await assert.rejects(malformed.addComment(123, 'MR'), { code: 'WRITE_UNCERTAIN' });
});

test('comments traverse every page without following server URLs', async () => {
  const skips = [];
  const client = make(async url => {
    const skip = Number(url.searchParams.get('skip'));
    skips.push(skip);
    assert.equal(url.origin, 'https://example.tpondemand.com');
    return skip === 0 ? json({ Items: [{ Id: 1 }], Next: 'https://evil.example/' }) : json({ Items: [{ Id: 2 }] });
  });
  assert.deepEqual((await client.comments(123)).map(c => c.Id), [1, 2]);
  assert.deepEqual(skips, [0, 1]);
});

test('pagination truncation and malformed collections fail closed', async () => {
  const client = make(async () => json({ Items: [], Next: true }));
  await assert.rejects(client.comments(123), { code: 'PAGE_LIMIT' });
  const malformed = make(async () => json({ Message: 'not a collection' }));
  await assert.rejects(malformed.comments(123), { code: 'INVALID_RESPONSE' });
});

test('search escapes filters, uses v1 ascending/descending syntax, includes watermarks', async () => {
  const seen = [];
  const client = make(async url => { seen.push(url); return json({ Items: [], Next: true }); });
  await client.search({ state: "In 'Testing", titleContains: 'a\\b', creatorId: 5, afterId: 221161, sort: 'created_asc' });
  assert.equal(seen[0].searchParams.get('orderBy'), 'CreateDate');
  assert.ok(seen[0].searchParams.get('where').includes("EntityState.Name eq 'In \\'Testing'"));
  assert.ok(seen[0].searchParams.get('where').includes('Owner.Id eq 5'));
  assert.ok(seen[0].searchParams.get('where').includes('Id gt 221161'));
  await client.search({ sort: 'created_desc' });
  assert.equal(seen[1].searchParams.get('orderByDesc'), 'CreateDate');
  assert.equal(quote("x'\\"), "'x\\'\\\\'");
});

test('assigned-to-me joins Assignments, deduplicates roles, sorts and paginates correctly', async () => {
  const client = make(async url => {
    if (url.pathname.endsWith('LoggedUser')) return json({ Id: 1615 });
    if (url.pathname.endsWith('Assignments')) {
      assert.ok(url.searchParams.get('where').includes('GeneralUser.Id eq 1615'));
      return json({ Items: [{ Assignable: { Id: 2 } }, { Assignable: { Id: 1 } }, { Assignable: { Id: 2 } }] });
    }
    assert.ok(url.searchParams.get('where').includes('Id in (2,1)'));
    return json({ Items: [{ Id: 2, CreateDate: '/Date(2000)/' }, { Id: 1, CreateDate: '/Date(1000)/' }] });
  });
  const result = await client.search({ assignedToMe: true, limit: 1 });
  assert.deepEqual(result.items.map(b => b.Id), [1]);
  assert.equal(result.hasMore, true);
  assert.equal(result.total, 2);
});
