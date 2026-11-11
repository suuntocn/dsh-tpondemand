import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

test('official MCP client initializes stdio server, lists supported tools and calls connection status', async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, TP_DISABLE_KEYCHAIN: '1', TP_BASE_URL: 'https://example.tpondemand.com' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'tp-smoke-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['tp_connection_status', 'tp_search_bugs', 'tp_get_bug',
    'tp_get_bug_comments', 'tp_get_bug_workflow', 'tp_list_severities', 'tp_search_projects', 'tp_search_users',
    'tp_get_bug_assignments', 'tp_get_bug_attachments', 'tp_read_attachment', 'tp_get_bug_relations',
    'tp_list_relation_types', 'tp_get_api_metadata', 'tp_preview_bug_changes', 'tp_apply_bug_changes',
    'tp_preview_mr_handoff', 'tp_apply_mr_handoff', 'tp_list_api_resources', 'tp_query_entities',
    'tp_get_entity', 'tp_api_get', 'tp_get_entity_workflow', 'tp_get_entity_comments', 'tp_get_entity_assignments',
    'tp_get_entity_attachments', 'tp_get_entity_relations', 'tp_preview_api_changes', 'tp_apply_api_changes',
    'tp_preview_attachment_upload', 'tp_read_entity_attachment', 'tp_download_attachment',
    'tp_search_cards', 'tp_my_work'].sort());
  assert.equal(tools.find(t => t.name === 'tp_apply_mr_handoff').annotations.readOnlyHint, false);
  const result = await client.callTool({ name: 'tp_connection_status', arguments: {} });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.connected, false);
  assert.equal(data.credentialSource, 'not_configured');
  const invalid = await client.callTool({ name: 'tp_get_bug', arguments: { bugId: -1 } });
  assert.equal(invalid.isError, true);
  const blocked = await client.callTool({ name: 'tp_apply_mr_handoff', arguments: { planId: '50f3cbe6-2715-4c82-8a77-8586c9707a13' } });
  assert.equal(blocked.isError, true);
  assert.ok(blocked.content[0].text.includes('PLAN_EXPIRED'));
  const emptyChange = await client.callTool({ name: 'tp_preview_bug_changes', arguments: { changes: [{ bugId: 12 }] } });
  assert.equal(emptyChange.isError, true);
  const unexpectedChange = await client.callTool({ name: 'tp_preview_bug_changes', arguments: { changes: [{ bugId: 12, targetState: 'Invalid', arbitraryFields: { Description: 'bad' } }] } });
  assert.equal(unexpectedChange.isError, true);
  const missingChangePlan = await client.callTool({ name: 'tp_apply_bug_changes', arguments: { planId: '50f3cbe6-2715-4c82-8a77-8586c9707a13' } });
  assert.equal(missingChangePlan.isError, true);
  assert.ok(missingChangePlan.content[0].text.includes('PLAN_EXPIRED'));
  assert.equal(tools.find(t => t.name === 'tp_apply_api_changes').annotations.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'tp_get_api_metadata').inputSchema.properties.entityType.enum, undefined);
  const missingApiPlan = await client.callTool({ name: 'tp_apply_api_changes', arguments: { planId: '50f3cbe6-2715-4c82-8a77-8586c9707a13' } });
  assert.ok(missingApiPlan.content[0].text.includes('PLAN_EXPIRED'));
  assert.equal(stderr, '');
});
