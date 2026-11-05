import test from 'node:test';
import assert from 'node:assert/strict';
import { TpClient } from '../src/client.mjs';
import { summarizeBug } from '../src/handoff.mjs';

const token = 'test-secret';
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const make = fetchImpl => new TpClient({ origin: 'https://example.tpondemand.com', token, fetchImpl });

test('detail and listing request severity importance and preserve it in public summaries', async () => {
  const severity = { Id: 41, Name: 'Tenant custom severity', Importance: 5 };
  const calls = [];
  const client = make(async url => {
    calls.push(url);
    assert.match(url.searchParams.get('include'), /Severity\[Id,Name,Importance\]/);
    return response(url.pathname.endsWith('/123') ? { Id: 123, Severity: severity } : { Items: [{ Id: 123, Severity: severity }] });
  });
  assert.deepEqual(summarizeBug(await client.getBug(123), client.origin).severity, severity);
  const page = await client.search({ severity: "It's critical", sort: 'severity_asc', offset: 2, limit: 1 });
  assert.deepEqual(summarizeBug(page.items[0], client.origin).severity, severity);
  assert.match(calls[1].searchParams.get('where'), /Severity.Name eq 'It\\'s critical'/);
  assert.equal(calls[1].searchParams.get('orderBy'), 'Severity.Importance');
  assert.equal(calls[1].searchParams.get('skip'), '2');
  assert.equal(page.nextOffset, 3);
  assert.equal(summarizeBug({ Id: 1 }, client.origin).severity, null);
});

test('assigned search sorts custom importance before paging, keeps missing severity last in both directions', async () => {
  const client = make(async url => {
    if (url.pathname.endsWith('LoggedUser')) return response({ Id: 5 });
    if (url.pathname.endsWith('Assignments')) return response({ Items: [1, 2, 3].map(Id => ({ Assignable: { Id } })) });
    return response({ Items: [{ Id: 1 }, { Id: 2, Severity: { Importance: 8 } }, { Id: 3, Severity: { Importance: 2 } }] });
  });
  const ascending = await client.search({ assignedToMe: true, sort: 'severity_asc', limit: 1 });
  assert.deepEqual(ascending.items.map(row => row.Id), [3]);
  assert.equal(ascending.hasMore, true);
  assert.deepEqual((await client.search({ assignedToMe: true, sort: 'severity_desc' })).items.map(row => row.Id), [2, 3, 1]);
});

test('new directory and metadata resources cannot be used to write or escape fixed paths', async () => {
  const client = make(async () => { throw new Error('must not reach network'); });
  for (const path of ['Projects', 'Users', 'Severities', 'Relations', 'Attachments/12', 'Bugs/meta']) {
    await assert.rejects(client.request(path, {}, { Name: 'bad' }), { code: 'READ_ONLY_RESOURCE' });
  }
  await assert.rejects(client.request('../Users'), { code: 'INVALID_PATH' });
  assert.throws(() => client.metadata('../Unknown'), { code: 'INVALID_RESOURCE' });
});

test('attachment reads verify bug ownership before downloading and never follow external URLs', async () => {
  let calls = 0;
  const client = make(async url => {
    calls++;
    if (url.pathname.includes('/api/')) return response({ Id: 9, General: { Id: 99 }, Uri: 'https://evil.example/' });
    throw new Error('must not download a different bug attachment');
  });
  await assert.rejects(client.readAttachment(9, 12), { code: 'ATTACHMENT_MISMATCH' });
  assert.equal(calls, 1);
});

test('MCP attachment images use verified bytes; text redacts credentials; oversized and HTML payloads fail', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let name = 'image.png';
  let bytes = png;
  let declaredSize = null;
  const client = make(async (url, options) => {
    if (url.pathname.includes('/api/')) return response({ Id: 9, Name: name, General: { Id: 12 } });
    assert.equal(url.origin, 'https://example.tpondemand.com');
    assert.equal(url.pathname, '/Attachment.aspx');
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('AttachmentID'), '9');
    return new Response(bytes, { headers: declaredSize ? { 'content-length': declaredSize } : {} });
  });
  assert.equal((await client.readAttachment(9, 12)).image.mimeType, 'image/png');
  name = 'debug.log'; bytes = Buffer.from(token);
  assert.equal((await client.readAttachment(9, 12)).text, '[REDACTED]');
  name = 'image.png'; bytes = Buffer.from('<html>login</html>');
  await assert.rejects(client.readAttachment(9, 12), { code: 'UNSUPPORTED_ATTACHMENT' });
  declaredSize = String(9 * 1024 * 1024);
  await assert.rejects(client.readAttachment(9, 12), { code: 'ATTACHMENT_TOO_LARGE' });
});
