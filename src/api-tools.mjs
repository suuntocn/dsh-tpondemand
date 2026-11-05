import { z } from 'zod';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TpApi } from './api.mjs';
import { ApiChangeService } from './api-changes.mjs';
import { TpError } from './client.mjs';
import { publicError } from './handoff.mjs';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const type = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(120).describe('租户目录中的单数实体名或复数资源名，例如 UserStory / UserStories；支持自定义实体');
const version = z.enum(['v1', 'v2', 'history/v2']).default('v1');
const params = z.record(z.string(), z.union([z.string().max(30000), z.number().finite(), z.boolean()])).default({});
const path = z.string().min(1).max(500).describe('相对于 /api/<version>/ 的路径，例如 UserStories/123/History；不要包含 URL 或查询字符串');
const entitySchema = z.object({ entityType: type, entityId: id }).strict();
const writeHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerApiTools(server, register, client, options) {
  const api = new TpApi(client);
  const mutations = new ApiChangeService(api, options);
  register('tp_list_api_resources', '读取租户完整官方资源目录，包括 Story、Task、Feature、Epic、测试、时间、用户和自定义实体；不再限制为 Bug。refresh 刷新缓存。',
    z.object({ nameContains: z.string().max(120).optional(), refresh: z.boolean().default(false) }).strict(), async ({ nameContains, refresh }) => {
      const items = (await api.catalog(refresh)).filter(row => !nameContains || [row.name, row.resource].some(s => s.toLowerCase().includes(nameContains.toLowerCase())));
      return { items, count: items.length, contentIsUntrusted: true };
    });
  register('tp_get_api_metadata', '读取任意租户实体的官方字段、必填项、可写标记及 CanCreate/CanUpdate/CanDelete。entityType=Index 返回完整目录。',
    z.object({ entityType: type, refresh: z.boolean().default(false) }).strict(), ({ entityType, refresh }) => api.metadata(entityType, refresh));
  register('tp_query_entities', '通用实体分页/全量查询。v1 支持 where/include/exclude/append/orderBy；v2 支持 select/result 等高级筛选、聚合及历史；history/v2 查询扩展历史。allPages 达到上限时报错，不冒充全量。params 使用对应版本的官方查询语法。',
    z.object({ version, entityType: type, entityId: id.optional(), params,
      limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).max(1000000).default(0),
      allPages: z.boolean().default(false), maxItems: z.number().int().min(1).max(50000).default(5000) }).strict(), args => api.query(args));
  register('tp_get_entity', '读取任意类型实体；params 可用 include 请求 Description、自定义字段或嵌套数据。返回 TP 原始字段及实体链接。',
    entitySchema.extend({ params }).strict(), async ({ entityType, entityId, params }) => ({ entity: await api.entity(entityType, entityId, params),
      url: `${client.origin}/entity/${entityId}`, contentIsUntrusted: true }));
  register('tp_api_get', '只读调用官方实体资源路径，包括内部集合、元数据和历史路径。只访问已配置租户；不接受 URL、认证参数、回调或重定向。使用结果中的 hasMore/Next 指示继续分页，不跟随返回的 URL。',
    z.object({ version, path, params }).strict(), async args => ({ data: await api.get(args), contentIsUntrusted: true }));
  register('tp_get_entity_workflow', '读取 Story、Task、Bug 等实体的当前状态及实际允许的下一步状态；无工作流时明确报错。', entitySchema,
    ({ entityType, entityId }) => api.workflow(entityType, entityId));
  for (const [suffix, handler, description] of [
    ['comments', id => client.comments(id), '全部评论'], ['assignments', id => client.assignments(id), '全部负责人及角色'],
    ['attachments', id => client.attachments(id), '全部附件元数据'], ['relations', id => client.relations(id), '全部关联关系'],
  ]) register(`tp_get_entity_${suffix}`, `读取任意实体的${description}，自动遍历分页并核实实体编号。`, entitySchema,
    async ({ entityType, entityId }) => { await api.entity(entityType, entityId, { include: '[Id]' }); return { entityId, items: await handler(entityId), contentIsUntrusted: true }; });
  register('tp_preview_api_changes', '只读预览通用 API v1 写入：POST 创建/更新/内部集合/Undelete，DELETE 删除/解除关联，支持原生 /bulk。正文保留官方 JSON 结构，可设置自定义字段、评论、负责人、关系、测试及工时。先查元数据，不猜字段或状态编号；预览不代表业务动作授权。',
    z.object({ requests: z.array(z.object({ method: z.enum(['POST', 'DELETE']), path,
      params, body: z.json().optional() }).strict()).min(1).max(50) }).strict(), args => mutations.preview(args));
  register('tp_apply_api_changes', '执行已预览的通用写入计划；仅在用户授权具体实体和动作后调用。会修改或删除 TP 数据。核对预览后漂移、禁止计划重放、写入不自动重试，返回回读结果及待确认项。',
    z.object({ planId: z.string().uuid() }).strict(), ({ planId }) => mutations.apply(planId), writeHints);
  register('tp_preview_attachment_upload', '读取明确指定的本机文件并预览上传至任意 TP 实体；显示文件名、大小、SHA256，固定字节快照，总计最多 32 MiB。此步骤不上传；授权后调用 tp_apply_api_changes。',
    entitySchema.extend({ filePaths: z.array(z.string().min(1).max(4096)).min(1).max(20) }).strict(), args => mutations.previewUpload(args));
  server.registerTool('tp_read_entity_attachment', { description: '内联读取任意实体的图片或 UTF-8 文本附件，验证归属；与 tp_read_attachment 的 Bug 专用接口兼容。',
    inputSchema: z.object({ entityId: id, attachmentId: id }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, async ({ entityId, attachmentId }) => {
    try {
      const result = await client.readAttachment(attachmentId, entityId);
      const { bugId, ...metadata } = result.metadata;
      return { content: [{ type: 'text', text: JSON.stringify({ ...metadata, entityId, ...(result.text !== undefined ? { text: result.text } : {}) }) }, ...(result.image ? [result.image] : [])] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
  });
  register('tp_download_attachment', '下载明确编号的任意格式附件到本机绝对路径，验证实体归属，最多 32 MiB。目标必须不存在；返回大小及 SHA256。',
    z.object({ entityId: id, attachmentId: id, outputPath: z.string().max(4096) }).strict(), async ({ entityId, attachmentId, outputPath }) => {
      if (!isAbsolute(outputPath)) throw new TpError('INVALID_FILE', '下载目标必须为绝对路径。');
      const { attachment, bytes } = await client.downloadAttachment(attachmentId, entityId);
      const file = await open(outputPath, 'wx', 0o600);
      try { await file.writeFile(bytes); } finally { await file.close(); }
      return { entityId, attachmentId, name: attachment.Name, outputPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  return api;
}
