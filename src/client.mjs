import { setTimeout as delay } from 'node:timers/promises';
import { tenantOrigin } from './config.mjs';

export class TpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function itemsOf(data) {
  if (!data || !Array.isArray(data.Items)) throw new TpError('INVALID_RESPONSE', 'TP 未返回预期的 Items 集合。');
  return data.Items;
}

export const quote = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
export const bugFields = 'Id,Name,CreateDate,ModifyDate,Severity[Id,Name,Importance],EntityState[Id,Name],Project[Id,Name],Owner[Id,FirstName,LastName]';
export const CARD_TYPES = { Bugs: 'Bug', UserStories: 'UserStory', Features: 'Feature', Epics: 'Epic', Tasks: 'Task' };
const cardFields = 'Id,Name,EntityState[Id,Name],Project[Id,Name],AssignedUser[Id,FirstName,LastName],ModifyDate';

export class TpClient {
  constructor({ origin, token, fetchImpl = fetch, sleep = delay, timeoutMs = 15000 }) {
    this.origin = tenantOrigin(origin);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
  }

  async request(path, params = {}, body) {
    if (!this.token) throw new TpError('NOT_CONFIGURED', '尚未配置 TP Token，请在 DSH 插件 → Targetprocess → 配置中填写并保存。');
    // Only fixed v1 resource paths are accepted. Never follow server-supplied Next URLs or redirects.
    if (!/^(Bugs(?:\/[1-9]\d*)?|Comments|Assignments|Users(?:\/LoggedUser)?|Projects|Severities|Relations|RelationTypes|Attachments(?:\/[1-9]\d*)?|(?:Bugs|Severities|Relations|RelationTypes|Attachments|Projects|Users|Assignments)\/meta)$/.test(path)) {
      throw new TpError('INVALID_PATH', '不支持的 TP API 路径。');
    }
    if (body !== undefined && !/^(Bugs\/[1-9]\d*|Comments)$/.test(path)) {
      throw new TpError('READ_ONLY_RESOURCE', '该资源仅开放只读查询。');
    }
    return this.apiRequest({ path, params, body, method: body === undefined ? 'GET' : 'POST' });
  }

  async apiRequest({ version = 'v1', path, params = {}, body, method = 'GET', form, responseFormat = 'json', maxBytes = 16 * 1024 * 1024 }) {
    if (!this.token) throw new TpError('NOT_CONFIGURED', '尚未配置 TP Token。');
    if (!['v1', 'v2', 'history/v2'].includes(version) || !['GET', 'POST', 'DELETE'].includes(method) ||
        !/^[A-Za-z][A-Za-z0-9_]*(?:\/(?:[A-Za-z][A-Za-z0-9_]*|[1-9]\d*))*$/.test(path) ||
        /(?:^|\/)(?:Authentication|AccessTokens?)(?:\/|$)/i.test(path)) {
      throw new TpError('INVALID_PATH', '只允许当前租户内的 TP 资源路径，不接受 URL、凭据或路径转义。');
    }
    if (version !== 'v1' && method !== 'GET') throw new TpError('READ_ONLY_RESOURCE', '官方 API v2 仅支持读取。');
    if (method === 'GET' && (body !== undefined || form)) throw new TpError('INVALID_REQUEST', 'GET 不接受请求正文。');
    const write = method !== 'GET';
    const url = new URL(form ? '/UploadFile.ashx' : `/api/${version}/${path}`, this.origin);
    for (const [key, value] of Object.entries(params)) {
      if (!/^[a-z][a-z0-9_]*$/i.test(key) || /token|password|secret|auth|callback|redirect|method|format/i.test(key)) {
        throw new TpError('INVALID_PARAMETER', '查询参数不得覆盖认证、格式、HTTP 方法或重定向。');
      }
      if (value !== undefined) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw new TpError('INVALID_PARAMETER', '查询参数必须是字符串、数字或布尔值。');
        url.searchParams.set(key, String(value));
      }
    }
    if (version === 'v1' && !form) {
      url.searchParams.set('format', responseFormat);
      if (write) url.searchParams.set('resultFormat', 'json');
    }
    url.searchParams.set('access_token', this.token);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Accept: responseFormat === 'xml' ? 'application/xml' : 'application/json', ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }) },
          ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new TpError(write ? 'WRITE_UNCERTAIN' : 'NETWORK', write ? '写入响应未收到；结果待回读确认，不自动重发。' : 'TP 请求超时或网络不可用。');
      }
      if (!write && [429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const retry = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await this.sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 5000) : 250 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const code = write && (response.status >= 500 || response.status === 408) ? 'WRITE_UNCERTAIN'
          : [401, 403].includes(response.status) ? 'AUTH_OR_PERMISSION' : `HTTP_${response.status}`;
        throw new TpError(code, `TP 返回 HTTP ${response.status}。`);
      }
      let raw;
      try {
        const bytes = await readBytes(response, maxBytes);
        // Documented DELETE responses may be empty with HTTP 200 (or 204).
        raw = bytes.length ? (responseFormat === 'xml' ? bytes.toString('utf8') : form ? parseUploadResponse(bytes) : JSON.parse(bytes.toString('utf8'))) : (write ? null : (() => { throw new Error(); })());
      } catch {
        throw new TpError(write ? 'WRITE_UNCERTAIN' : 'INVALID_RESPONSE', 'TP 返回内容不完整、过大或不是有效 JSON；写入需回读确认。');
      }
      return this.sanitize(raw);
    }
  }

  sanitize(value) {
    const secrets = [this.token, encodeURIComponent(this.token ?? '')].filter(Boolean);
    const redact = text => secrets.reduce((out, secret) => out.replaceAll(secret, '[REDACTED]'), text);
    const walk = data => {
      if (typeof data === 'string') return redact(data);
      if (Array.isArray(data)) return data.map(walk);
      if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([key, val]) =>
        [redact(key), /^(next|prev)$/i.test(key) ? (val ? true : undefined) : /^(access_token|token|password|secret)$/i.test(key) ? '[REDACTED]' : walk(val)]));
      return data;
    };
    return walk(value);
  }

  currentUser() { return this.request('Users/LoggedUser', { include: '[Id,FirstName,LastName]' }); }

  metadata(entityType) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(entityType)) throw new TpError('INVALID_RESOURCE', '实体名称无效。');
    const legacy = { Bug: 'Bugs', Severity: 'Severities', Relation: 'Relations', RelationType: 'RelationTypes',
      Attachment: 'Attachments', Project: 'Projects', User: 'Users', Assignment: 'Assignments' };
    return this.apiRequest({ path: `${legacy[entityType] ?? entityType}/meta`, ...(entityType.toLowerCase() === 'index' ? { responseFormat: 'xml' } : {}) });
  }

  severities() { return this.all('Severities', { include: '[Id,Name,Importance]', orderBy: 'Importance' }); }
  relationTypes() { return this.all('RelationTypes', { orderBy: 'Id' }); }
  assignments(id) { return this.all('Assignments', { where: `Assignable.Id eq ${id}`,
    include: '[Id,GeneralUser[Id,FirstName,LastName],Role[Id,Name]]', orderBy: 'Id' }); }
  attachments(id) { return this.all('Attachments', { where: `General.Id eq ${id}`, orderBy: 'Id' }); }
  attachment(id) { return this.request(`Attachments/${id}`); }
  relations(id) { return this.all('Relations', { where: `(Master.Id eq ${id})or(Slave.Id eq ${id})`, orderBy: 'Id' }); }

  async directory(resource, { nameContains, limit = 50, offset = 0 } = {}) {
    if (!['Users', 'Projects'].includes(resource)) throw new TpError('INVALID_PATH', '不支持的目录资源。');
    const field = resource === 'Users' ? `(FirstName contains ${quote(nameContains ?? '')})or(LastName contains ${quote(nameContains ?? '')})` : `Name contains ${quote(nameContains ?? '')}`;
    const result = await this.request(resource, { where: nameContains ? field : undefined,
      include: resource === 'Users' ? '[Id,FirstName,LastName,IsActive]' : '[Id,Name]', orderBy: 'Id', take: limit, skip: offset });
    const items = itemsOf(result);
    return { items, hasMore: !!result.Next, nextOffset: offset + items.length };
  }

  getBug(id) {
    return this.request(`Bugs/${id}`, { include: `[${bugFields.replace('EntityState[Id,Name]', 'EntityState[Id,Name,NextStates[Id,Name]]')},Description]`, innerTake: 1000 });
  }

  async all(path, params, limit = 5000) {
    const rows = [];
    for (let skip = 0; ; ) {
      const result = await this.request(path, { ...params, take: Math.min(200, limit - rows.length), skip });
      const page = itemsOf(result);
      rows.push(...page);
      if (!result.Next) return rows;
      if (!page.length || rows.length >= limit) throw new TpError('PAGE_LIMIT', '记录过多或分页异常，请缩小查询范围；未将截断结果视为完整数据。');
      skip += page.length;
    }
  }

  comments(id) {
    return this.all('Comments', { where: `General.Id eq ${id}`, include: '[Id,Description,CreateDate,Owner[Id,FirstName,LastName]]', orderBy: 'Id' });
  }

  async search(filters = {}) {
    const clauses = [];
    if (filters.projectId) clauses.push(`Project.Id eq ${filters.projectId}`);
    if (filters.creatorId) clauses.push(`Owner.Id eq ${filters.creatorId}`);
    if (filters.state) clauses.push(`EntityState.Name eq ${quote(filters.state)}`);
    if (filters.stateId) clauses.push(`EntityState.Id eq ${filters.stateId}`);
    if (filters.severity) clauses.push(`Severity.Name eq ${quote(filters.severity)}`);
    if (filters.severityId) clauses.push(`Severity.Id eq ${filters.severityId}`);
    if (filters.titleContains) clauses.push(`Name contains ${quote(filters.titleContains)}`);
    if (filters.afterId) clauses.push(`Id gt ${filters.afterId}`);
    if (filters.createdAfter) clauses.push(`CreateDate gte ${quote(filters.createdAfter)}`);
    const sort = filters.sort ?? 'created_asc';
    const sortField = sort.startsWith('severity_') ? 'Severity.Importance' : sort.startsWith('id_') ? 'Id' : 'CreateDate';
    const order = sort.endsWith('_desc') ? 'orderByDesc' : 'orderBy';
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const base = { include: `[${bugFields}]`, [order]: sortField };
    if (filters.assignedToMe || filters.assigneeId) {
      const userId = filters.assigneeId ?? (await this.currentUser()).Id;
      if (!Number.isSafeInteger(userId)) throw new TpError('INVALID_RESPONSE', '未能确认当前账号编号。');
      const assignments = await this.all('Assignments', {
        where: `(GeneralUser.Id eq ${userId})and(Assignable.EntityType.Name eq 'Bug')`,
        include: '[Id,Assignable[Id]]', orderBy: 'Id',
      });
      const ids = [...new Set(assignments.map(row => row.Assignable?.Id).filter(Number.isSafeInteger))];
      const found = [];
      // v1 cannot filter nested assignment collections; join through Assignments, then query Bugs in bounded chunks.
      for (let start = 0; start < ids.length; start += 100) {
        const where = [...clauses, `Id in (${ids.slice(start, start + 100).join(',')})`].map(c => `(${c})`).join('and');
        found.push(...await this.all('Bugs', { ...base, where }));
      }
      const unique = [...new Map(found.map(b => [b.Id, b])).values()];
      unique.sort((a, b) => {
        if (sortField === 'Severity.Importance') {
          const aMissing = !Number.isFinite(a.Severity?.Importance);
          const bMissing = !Number.isFinite(b.Severity?.Importance);
          if (aMissing !== bMissing) return aMissing ? 1 : -1;
        }
        const av = sortField === 'Id' ? a.Id : sortField === 'Severity.Importance' ? (a.Severity?.Importance ?? Infinity) : dateNumber(a.CreateDate);
        const bv = sortField === 'Id' ? b.Id : sortField === 'Severity.Importance' ? (b.Severity?.Importance ?? Infinity) : dateNumber(b.CreateDate);
        return ((av - bv) || a.Id - b.Id) * (order === 'orderByDesc' ? -1 : 1);
      });
      return { items: unique.slice(offset, offset + limit), hasMore: unique.length > offset + limit, nextOffset: offset + limit, total: unique.length };
    }
    const result = await this.request('Bugs', { ...base, where: clauses.length ? clauses.map(c => `(${c})`).join('and') : undefined, take: limit, skip: offset });
    const items = itemsOf(result);
    return { items, hasMore: !!result.Next, nextOffset: offset + items.length };
  }

  // Keyword search across card-like entities. Each type is queried independently so one
  // unavailable resource cannot hide the others.
  async cards({ keyword, entityTypes, field = 'any', limit = 20, offset = 0 }) {
    const text = quote(keyword);
    const where = field === 'name' ? `Name contains ${text}`
      : field === 'description' ? `Description contains ${text}`
        : `Name contains ${text} or Description contains ${text}`;
    return this.collectCards(entityTypes, { where, include: `[${cardFields}]`, orderByDesc: 'ModifyDate', take: limit, skip: offset },
      { keyword, field, offset, limit });
  }

  async myWork({ userId, entityTypes, state, includeFinished = false, limit = 20 }) {
    const clauses = [`AssignedUser.Id eq ${userId}`];
    if (state) clauses.push(`EntityState.Name eq ${quote(state)}`);
    else if (!includeFinished) clauses.push("EntityState.IsFinal eq 'false'");
    return this.collectCards(entityTypes, { where: clauses.join(' and '), include: `[${cardFields}]`, orderByDesc: 'ModifyDate', take: limit },
      { assignee: { id: userId }, includeFinished: !!state || includeFinished, limit });
  }

  async collectCards(entityTypes, params, context) {
    const items = [];
    const pages = {};
    for (const resource of entityTypes) {
      const entityType = CARD_TYPES[resource];
      try {
        const result = await this.apiRequest({ path: resource, params });
        const rows = itemsOf(result);
        pages[resource] = {
          entityType, returned: rows.length, hasMore: !!result.Next,
          ...(context.offset === undefined ? {} : { nextOffset: context.offset + rows.length }),
        };
        items.push(...rows.map(row => ({ entityType, ...cardSummary(row, this.origin) })));
      } catch (error) {
        if (!(error instanceof TpError)) throw error;
        pages[resource] = { entityType, error: error.message };
      }
    }
    items.sort((a, b) => dateNumber(b.modifiedAt) - dateNumber(a.modifiedAt));
    return { ...context, pages, items, contentIsUntrusted: true };
  }

  setState(id, stateId) { return this.request(`Bugs/${id}`, {}, { EntityState: { Id: stateId } }); }
  addComment(id, description) { return this.request('Comments', {}, { Description: description, General: { Id: id } }); }

  async downloadAttachment(id, entityId, maxBytes = 32 * 1024 * 1024) {
    const attachment = await this.attachment(id);
    if (attachment.Id !== id || attachment.General?.Id !== entityId) throw new TpError('ATTACHMENT_MISMATCH', '附件不属于指定实体，未下载。');
    const url = new URL('/Attachment.aspx', this.origin);
    url.searchParams.set('AttachmentID', String(id));
    url.searchParams.set('access_token', this.token);
    let response;
    try { response = await this.fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: '*/*' } }); }
    catch { throw new TpError('NETWORK', '附件读取失败；未跟随重定向或使用浏览器会话。'); }
    if (!response.ok) { await response.body?.cancel(); throw new TpError(`HTTP_${response.status}`, `附件读取返回 HTTP ${response.status}。`); }
    try { return { attachment, bytes: await readBytes(response, maxBytes) }; }
    catch (error) {
      if (error.code === 'RESPONSE_TOO_LARGE') throw new TpError('ATTACHMENT_TOO_LARGE', '附件超过读取大小上限。');
      throw new TpError('NETWORK', '附件内容读取不完整。');
    }
  }

  async readAttachment(id, bugId) {
    const { attachment, bytes } = await this.downloadAttachment(id, bugId, 8 * 1024 * 1024);
    const size = bytes.length;
    let mimeType;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
    else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif';
    else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
    const metadata = { attachmentId: id, bugId, name: attachment.Name, size, url: `${this.origin}/Attachment.aspx?AttachmentID=${id}`, contentIsUntrusted: true };
    if (mimeType) return { metadata: { ...metadata, mimeType }, image: { type: 'image', data: bytes.toString('base64'), mimeType } };
    if (size <= 256 * 1024 && /\.(txt|log|json|md|csv|tsv|xml|yaml|yml|ets|swift)$/i.test(attachment.Name ?? '')) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.includes('\0')) throw new Error();
        return { metadata: { ...metadata, mimeType: 'text/plain' }, text: text.replaceAll(this.token, '[REDACTED]') };
      } catch { throw new TpError('UNSUPPORTED_ATTACHMENT', '附件不是有效的 UTF-8 文本。'); }
    }
    throw new TpError('UNSUPPORTED_ATTACHMENT', '只内联读取 PNG/JPEG/GIF/WebP 图片或不超过 256 KiB 的 UTF-8 文本；其他格式可通过附件元数据定位。');
  }
}

function assignedUsers(value) {
  const rows = Array.isArray(value) ? value : value?.Items ?? (value ? [value] : []);
  return rows.map(user => ({ id: user.Id, name: [user.FirstName, user.LastName].filter(Boolean).join(' ') }));
}

export function cardSummary(row, origin) {
  return {
    id: row.Id, name: row.Name, state: row.EntityState?.Name ?? null,
    project: row.Project ? { id: row.Project.Id, name: row.Project.Name } : null,
    assignees: assignedUsers(row.AssignedUser),
    modifiedAt: row.ModifyDate, url: `${origin}/entity/${row.Id}`,
  };
}

function dateNumber(value) {
  const legacy = typeof value === 'string' && /^\/Date\((-?\d+)/.exec(value);
  const n = legacy ? Number(legacy[1]) : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

export async function readBytes(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new TpError('RESPONSE_TOO_LARGE', '响应超过读取上限。'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new TpError('RESPONSE_TOO_LARGE', '响应超过读取上限。'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}

function parseUploadResponse(bytes) {
  const text = bytes.toString('utf8');
  try { return JSON.parse(text); } catch { return { uploadResponse: text }; }
}
