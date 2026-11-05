import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, basename, resolve } from 'node:path';
import { TpError } from './client.mjs';
import { propertiesOf, validateId } from './api.mjs';
import { acquireLock, defaultStateDir, publicError } from './handoff.mjs';

const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A plan lives 10 minutes; apply re-validates against metadata no older than that instead of
// refetching it on every write. Current values are still re-read on every apply.
const PLAN_TTL_MS = 600000;
const APPLY_METADATA_MAX_AGE_MS = PLAN_TTL_MS;
const transitionInclude = 'EntityState[Id,Name,NextStates[Id,Name]]';
export function containsExpected(actual, expected) {
  if (Array.isArray(expected)) {
    const rows = Array.isArray(actual) ? actual : actual?.Items;
    return Array.isArray(rows) && !actual?.Next && rows.length === expected.length && expected.every((e, i) => containsExpected(rows[i], e));
  }
  if (object(expected)) return object(actual) && Object.entries(expected).every(([key, value]) => containsExpected(actual[key], value));
  return actual === expected;
}

export class ApiChangeService {
  constructor(api, { stateDir = defaultStateDir, now = () => Date.now() } = {}) {
    this.api = api; this.client = api.client; this.stateDir = stateDir; this.now = now; this.plans = new Map();
  }

  // withTransitions also reads EntityState.NextStates so a state change needs no separate workflow read.
  async snapshot(resource, id, fields = [], withTransitions = false) {
    const meta = await this.api.metadata(resource);
    const readable = propertiesOf(meta).filter(p => p.CanGet).map(p => p.Name);
    const include = [...new Set(['Id', ...(readable.includes('ModifyDate') ? ['ModifyDate'] : []), ...fields.filter(field => readable.includes(field))])]
      .map(field => withTransitions && field === 'EntityState' ? transitionInclude : field);
    if (withTransitions && !include.includes(transitionInclude)) include.push(transitionInclude);
    return this.api.entity(resource, id, { include: `[${include.join(',')}]`, innerTake: 1000 });
  }

  checkTransition(before, target) {
    const state = before?.EntityState;
    if (!state || !Number.isSafeInteger(state.Id)) throw new TpError('NO_WORKFLOW', '该实体没有可用的 EntityState 工作流。');
    const next = state.NextStates;
    if (next?.Next) throw new TpError('WORKFLOW_TRUNCATED', '工作流列表被截断，请核实后再修改。');
    const nextStates = Array.isArray(next) ? next : next?.Items ?? [];
    if (target !== state.Id && !nextStates.some(s => s.Id === target)) throw new TpError('INVALID_TRANSITION', '目标状态不在当前实体允许的下一步状态内。');
  }

  async validateBody(resource, data, action, meta) {
    if (!object(data)) throw new TpError('INVALID_BODY', '创建和更新的正文必须是 JSON 对象。');
    if (Object.keys(data).some(k => /^id$/i.test(k) && k !== 'Id')) throw new TpError('INVALID_BODY', '顶层编号字段须使用 Id。');
    const props = propertiesOf(meta);
    for (const key of Object.keys(data)) {
      if (key === 'Id') continue;
      const prop = props.find(p => p.Name === key);
      if (props.length && (!prop || !prop.CanSet)) throw new TpError('FIELD_NOT_WRITABLE', `字段 ${key} 未在元数据中声明为可写。`);
    }
    if (action === 'create') for (const prop of props.filter(p => p.IsRequired && p.CanSet && p.Name !== 'Id')) {
      if (data[prop.Name] === undefined || data[prop.Name] === null) throw new TpError('REQUIRED_FIELD', `创建缺少必填字段 ${prop.Name}。`);
    }
    if (data.Id !== undefined) validateId(data.Id);
    // The allowed-transition check runs against the before snapshot, which reads the workflow too.
    if (action === 'update' && data.EntityState !== undefined) validateId(data.EntityState?.Id);
  }

  async prepare(request, refreshMetadata = false) {
    if (Buffer.byteLength(stable(request)) > 4 * 1024 * 1024) throw new TpError('BODY_TOO_LARGE', '单项 JSON 正文超过 4 MiB。');
    if (!['POST', 'DELETE'].includes(request.method)) throw new TpError('INVALID_METHOD', 'API v1 写操作使用 POST 或 DELETE。');
    // Validate query arguments before any write; never permit auth/method/format override.
    for (const key of Object.keys(request.params ?? {})) if (!/^[a-z][a-z0-9_]*$/i.test(key) || /token|password|secret|auth|callback|redirect|method|format/i.test(key)) {
      throw new TpError('INVALID_PARAMETER', '写入查询参数包含受保护参数。');
    }
    if (request.path === 'Undelete') {
      if (request.method !== 'POST' || !['Project', 'User'].includes(request.body?.entityType)) throw new TpError('INVALID_UNDELETE', '官方 Undelete 仅用于 Project/User。');
      const id = validateId(request.body.id);
      let before = null;
      try { before = await this.snapshot(request.body.entityType, id); } catch (error) { if (error.code !== 'HTTP_404') throw error; }
      return { request, kind: 'undelete', targets: [{ resource: request.body.entityType, id, before, fields: [] }] };
    }
    const { row, path } = await this.api.path(request.path);
    const meta = await this.api.metadata(row.resource, false, refreshMetadata ? APPLY_METADATA_MAX_AGE_MS : Infinity);
    const tail = path.split('/').slice(1);
    const targets = [];
    const add = async (data, action) => {
      const capability = { create: 'CanCreate', update: 'CanUpdate', delete: 'CanDelete' }[action];
      if (row.history || meta[capability] !== true) throw new TpError('OPERATION_NOT_SUPPORTED', `租户元数据未开放 ${action}。`);
      if (action !== 'delete') await this.validateBody(row.resource, data, action, meta);
      const id = action === 'create' ? undefined : validateId(data.Id);
      const fields = action === 'delete' ? propertiesOf(meta).filter(p => p.CanGet && !p.IsTypeComplex).map(p => p.Name) : Object.keys(data).filter(k => k !== 'Id');
      const transition = action === 'update' && data.EntityState !== undefined;
      const before = id ? await this.snapshot(row.resource, id, fields, transition) : null;
      if (transition) this.checkTransition(before, data.EntityState.Id);
      targets.push({ resource: row.resource, id, action, fields, desired: data, before });
    };
    let kind;
    if (!tail.length) {
      if (request.method !== 'POST' || !object(request.body) || Object.keys(request.body).some(k => /^id$/i.test(k))) throw new TpError('INVALID_CREATE', '创建必须 POST 到集合且正文不含 Id；更新请指定路径编号。');
      kind = 'create'; await add(request.body, kind);
    } else if (tail.length === 1 && tail[0] === 'bulk') {
      if (!Array.isArray(request.body) || !request.body.length || request.body.length > 500) throw new TpError('INVALID_BULK', 'bulk 正文须包含 1–500 项。');
      kind = 'bulk';
      for (const data of request.body) {
        if (!object(data)) throw new TpError('INVALID_BODY', 'bulk 中每项必须是对象。');
        if (request.method === 'DELETE' && Object.keys(data).some(k => k !== 'Id')) throw new TpError('INVALID_DELETE', 'bulk 删除只接受明确的 Id。');
        await add(data, request.method === 'DELETE' ? 'delete' : data.Id === undefined ? 'create' : 'update');
      }
    } else if (tail.length === 1 && /^\d+$/.test(tail[0])) {
      const id = validateId(tail[0]);
      if (request.body?.Id !== undefined && request.body.Id !== id) throw new TpError('ID_MISMATCH', '正文 Id 与路径不一致。');
      if (request.method === 'DELETE' && request.body !== undefined) throw new TpError('INVALID_DELETE', '单条删除不接受正文。');
      if (request.method === 'POST' && !object(request.body)) throw new TpError('INVALID_BODY', '更新必须提供 JSON 对象。');
      kind = request.method === 'DELETE' ? 'delete' : 'update';
      await add({ ...request.body, Id: id }, kind);
    } else if ([2, 3].includes(tail.length) && /^\d+$/.test(tail[0]) && /^[A-Za-z]\w*$/.test(tail[1]) && (tail.length === 2 || /^\d+$/.test(tail[2]))) {
      if (meta.CanUpdate !== true || !propertiesOf(meta).some(p => p.Name === tail[1])) throw new TpError('INVALID_COLLECTION', '元数据没有可更新的该内部集合。');
      kind = 'collection'; const id = validateId(tail[0]);
      targets.push({ resource: row.resource, id, fields: [tail[1]], before: await this.snapshot(row.resource, id, [tail[1]]) });
    } else throw new TpError('INVALID_PATH', '写入路径须为集合、编号、bulk 或实体内部集合。');
    const ids = targets.filter(t => t.id).map(t => `${t.resource}/${t.id}`);
    if (new Set(ids).size !== ids.length) throw new TpError('DUPLICATE_TARGET', '同一 bulk 中不能重复修改或删除同一编号。');
    return { request: { ...request, path }, kind, targets };
  }

  save(rows) {
    for (const [id, plan] of this.plans) if (plan.expiresAt <= this.now()) this.plans.delete(id);
    // Applied plans stay until expiry so they cannot be replayed, but no longer take a slot.
    if ([...this.plans.values()].filter(p => p.status !== 'used').length >= 10) throw new TpError('PLAN_LIMIT', '待执行计划过多，请等待过期或重连。');
    if ([...this.plans.values()].flatMap(p => p.rows).concat(rows).flatMap(r => r.files ?? []).reduce((n, f) => n + f.bytes.length, 0) > 64 * 1024 * 1024) throw new TpError('PLAN_LIMIT', '上传快照总计超过 64 MiB，请等待计划过期。');
    const plan = { planId: randomUUID(), expiresAt: this.now() + PLAN_TTL_MS, rows, status: 'ready' };
    this.plans.set(plan.planId, plan);
    return this.client.sanitize({ planId: plan.planId, expiresAt: new Date(plan.expiresAt).toISOString(), mode: 'preview',
      requests: rows.map(row => ({ request: row.request, kind: row.kind, targets: row.targets, files: row.files?.map(f => ({ name: f.name, size: f.bytes.length, sha256: f.sha256 })) })),
      note: '未写入 TP。完整核对路径、正文、影响编号后，沿用用户对具体业务动作的授权执行。批量不是事务；内部集合/复杂字段可能仅能确认请求已接受。' });
  }

  async preview({ requests }) {
    if (!Array.isArray(requests) || !requests.length || requests.length > 50 || Buffer.byteLength(stable(requests)) > 8 * 1024 * 1024) throw new TpError('PLAN_TOO_LARGE', '计划须为 1–50 项，JSON 总计最多 8 MiB。');
    const rows = [];
    for (const request of requests) rows.push(await this.prepare(structuredClone(request)));
    const targets = rows.flatMap(r => r.targets).filter(t => t.id).map(t => `${t.resource}/${t.id}`);
    if (new Set(targets).size !== targets.length) throw new TpError('DUPLICATE_TARGET', '同一计划不能多次修改同一实体；请合并更新正文。');
    if (rows.reduce((n, row) => n + row.targets.length, 0) > 500) throw new TpError('PLAN_TOO_LARGE', '一个计划最多影响 500 个实体。');
    return this.save(rows);
  }

  async previewUpload({ entityType, entityId, filePaths }) {
    const before = await this.snapshot(entityType, entityId);
    const files = [];
    let size = 0;
    for (const path of filePaths) {
      if (!isAbsolute(path)) throw new TpError('INVALID_FILE', '上传文件必须使用绝对路径。');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024 - size) throw new TpError('FILE_TOO_LARGE', '仅接受普通文件；计划上传总计最多 32 MiB。');
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) { const part = await file.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw new TpError('FILE_CHANGED', '读取上传文件时内容发生变化。'); offset += part.bytesRead; }
        const after = await file.stat();
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new TpError('FILE_CHANGED', '读取上传文件时内容发生变化。');
        size += bytes.length; files.push({ name: basename(path), bytes, sha256: hash(bytes) });
      } finally { await file.close(); }
    }
    const attachmentIds = (await this.client.attachments(entityId)).map(a => a.Id);
    return this.save([{ kind: 'upload', attachmentIds, request: { method: 'POST', path: 'UploadFile.ashx', entityId, entityType },
      targets: [{ resource: entityType, id: entityId, fields: [], before }], files }]);
  }

  async verify(row, receipt) {
    if (row.kind === 'upload') {
      const candidates = (await this.client.attachments(row.request.entityId)).filter(a => !row.attachmentIds.includes(a.Id));
      const checks = [];
      for (const file of row.files) {
        let found;
        for (const attachment of candidates.filter(a => a.Name === file.name && a.Size === file.bytes.length)) {
          const { bytes } = await this.client.downloadAttachment(attachment.Id, row.request.entityId);
          if (hash(bytes) === file.sha256) { found = attachment.Id; candidates.splice(candidates.indexOf(attachment), 1); break; }
        }
        checks.push({ name: file.name, attachmentId: found, verified: found !== undefined });
      }
      return { verified: checks.every(c => c.verified), checks };
    }
    if (row.kind === 'collection') return { verified: false, reason: '请求已接受；请回读内部集合或附件列表确认具体业务结果。' };
    const results = Array.isArray(receipt) ? receipt : receipt?.Items ?? [receipt];
    const checks = [];
    for (let i = 0; i < row.targets.length; i++) {
      const target = row.targets[i];
      const id = target.id ?? results[i]?.Id;
      if (!Number.isSafeInteger(id)) return { verified: false, reason: '响应未返回可唯一回读的创建编号。' };
      try {
        const after = await this.snapshot(target.resource, id, target.fields);
        const verified = row.kind === 'undelete' ? true : target.action !== 'delete' && containsExpected(after, { ...target.desired, Id: id });
        checks.push({ entityId: id, verified, after });
      } catch (error) {
        if (target.action === 'delete' && error.code === 'HTTP_404') checks.push({ entityId: id, verified: true, deleted: true });
        else throw error;
      }
    }
    return { verified: checks.every(c => c.verified), checks };
  }

  async applyOne(row) {
    if (!['upload', 'undelete'].includes(row.kind)) {
      const fresh = await this.prepare(row.request, true);
      if (stable(fresh.targets.map(t => t.before)) !== stable(row.targets.map(t => t.before))) {
        throw new TpError('ENTITY_CHANGED', '实体在预览后发生变化，请重新预览。');
      }
    } else for (const target of row.targets) if (target.id) {
      let fresh = null;
      try { fresh = await this.snapshot(target.resource, target.id, target.fields); } catch (error) { if (row.kind !== 'undelete' || error.code !== 'HTTP_404') throw error; }
      if (stable(fresh) !== stable(target.before)) throw new TpError('ENTITY_CHANGED', '实体在预览后发生变化，请重新预览。');
    }
    const pendingId = hash({ origin: this.client.origin, request: row.request, files: row.files?.map(f => f.sha256) });
    const pending = resolve(this.stateDir, `api-${pendingId}.pending`);
    try { await writeFile(pending, JSON.stringify({ pendingId, method: row.request.method, path: row.request.path, startedAt: new Date(this.now()).toISOString() }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') throw new TpError('WRITE_PENDING', `同一写入结果待确认，不重发。pendingId: ${pendingId}`); throw error; }
    let receipt, writeError;
    try {
      if (row.kind === 'upload') {
        const form = new FormData(); form.set('generalId', String(row.request.entityId));
        for (const file of row.files) form.append('file', new Blob([file.bytes]), file.name);
        receipt = await this.client.apiRequest({ path: 'Attachments', method: 'POST', form });
      } else receipt = await this.client.apiRequest(row.request);
    } catch (error) { writeError = error; }
    if (writeError && writeError.code !== 'WRITE_UNCERTAIN') { await unlink(pending); throw writeError; }
    let verification;
    try { verification = await this.verify(row, receipt); }
    catch (error) { verification = { verified: false, error: publicError(error) }; }
    if (verification.verified) await unlink(pending);
    return { path: row.request.path, outcome: verification.verified ? (writeError ? 'verified_after_uncertain_write' : 'verified') : writeError ? 'write_uncertain' : 'accepted_unverified',
      receipt, verification, ...(verification.verified ? {} : { pendingId }), ...(writeError ? { error: publicError(writeError) } : {}) };
  }

  async apply(planId) {
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= this.now()) throw new TpError('PLAN_EXPIRED', '计划不存在或已过期，请重新预览。');
    if (plan.status !== 'ready') throw new TpError('PLAN_USED', '该计划已执行或正在执行，不能重放。');
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = resolve(this.stateDir, `${hash(this.client.origin)}.lock`);
    const lock = await acquireLock(lockPath);
    plan.status = 'running';
    try {
      const results = [];
      for (const row of plan.rows) {
        try { results.push(await this.applyOne(row)); }
        catch (error) { results.push({ path: row.request.path, outcome: 'failed', error: publicError(error) }); }
      }
      const report = this.client.sanitize({ planId, results, verified: results.filter(r => r.outcome.startsWith('verified')).length,
        note: '非事务批量。accepted_unverified/write_uncertain 不代表操作失败；请先回读，禁止盲目重发。' });
      await writeFile(resolve(this.stateDir, `api-report-${planId}.json`), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' }).catch(() => {});
      return report;
    } finally { plan.status = 'used'; plan.rows = []; await lock.close(); await unlink(lockPath); }
  }
}
