import { TpError } from './client.mjs';

const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
const entityId = /^[1-9]\d*$/;
const decodeXml = text => text.replace(/&(amp|quot|apos|lt|gt);/g, (_, key) =>
  ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[key]).replace(/&#(x[\da-f]+|\d+);/gi, (_, num) =>
  String.fromCodePoint(num[0].toLowerCase() === 'x' ? parseInt(num.slice(1), 16) : Number(num)));

// The tenant serializes Index/meta JSON using duplicate property names. XML preserves every resource.
export function parseCatalog(xml, origin) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new TpError('INVALID_METADATA', '元数据目录格式无效。');
  const rows = [];
  for (const match of xml.matchAll(/<ResourceMetadataDescription\b([^>]*?)\/?\s*>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value)]));
    let url;
    try { url = new URL(attrs.Uri); } catch { continue; }
    const path = /^\/api\/v1\/([A-Za-z][A-Za-z0-9_]*)\/meta$/.exec(url.pathname);
    if (!identifier.test(attrs.Name) || !path || url.origin !== origin || url.search || url.hash || url.username || url.password) continue;
    if (/^(Authentication|AccessTokens?)$/i.test(path[1])) continue;
    rows.push({ name: attrs.Name, resource: path[1], description: attrs.Description ?? '' });
  }
  if (!rows.length) throw new TpError('INVALID_METADATA', '未读到有效的 TP 资源目录。');
  return [...new Map(rows.map(row => [row.resource.toLowerCase(), row])).values()];
}

export function propertiesOf(metadata) {
  const rows = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.Name === 'string' && typeof value.CanSet === 'boolean') rows.push(value);
    for (const item of Object.values(value)) if (item && typeof item === 'object') {
      if (Array.isArray(item)) item.forEach(walk); else walk(item);
    }
  };
  walk(metadata.ResourceMetadataPropertiesDescription);
  return rows;
}

export class TpApi {
  constructor(client, { now = () => Date.now() } = {}) { this.client = client; this.now = now; this.catalogCache = undefined; this.metaCache = new Map(); }

  async catalog(refresh = false) {
    if (!this.catalogCache || refresh) {
      const rows = parseCatalog(await this.client.apiRequest({ path: 'Index/meta', responseFormat: 'xml' }), this.client.origin);
      this.catalogCache = rows;
      if (refresh) this.metaCache.clear();
    }
    return this.catalogCache;
  }

  async resolve(name) {
    if (!identifier.test(name)) throw new TpError('INVALID_RESOURCE', '实体名称无效；请先查询资源目录。');
    const key = name.toLowerCase();
    const row = (await this.catalog()).find(row => [row.name, row.resource].some(alias => alias.toLowerCase() === key));
    if (row) return row;
    // The documented history resources are not included in Index/meta on every tenant.
    const history = /^(.*?)(History|Histories)$/i.exec(name);
    if (history) {
      const base = await this.resolve(history[1]);
      return { name: `${base.name}History`, resource: `${base.name}Histories`, history: true };
    }
    throw new TpError('UNKNOWN_RESOURCE', '租户元数据没有该实体；请刷新资源目录核实名称。');
  }

  // refresh=true always refetches; maxAgeMs refetches only entries older than that age.
  async metadata(name, refresh = false, maxAgeMs = Infinity) {
    if (name.toLowerCase() === 'index') return { items: await this.catalog(refresh) };
    const row = await this.resolve(name);
    const cached = this.metaCache.get(row.resource);
    if (!cached || refresh || this.now() - cached.at > maxAgeMs) {
      this.metaCache.set(row.resource, { at: this.now(), value: await this.client.apiRequest({ path: `${row.resource}/meta` }) });
    }
    return this.metaCache.get(row.resource).value;
  }

  async path(path, version = 'v1') {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\/(?:[A-Za-z][A-Za-z0-9_]*|[1-9]\d*))*$/.test(path) || path.length > 500) {
      throw new TpError('INVALID_PATH', '请提供相对资源路径，不可包含 URL、查询参数或转义。');
    }
    const [head, ...tail] = path.split('/');
    const row = await this.resolve(head);
    return { row, path: [version === 'v1' ? row.resource : row.history ? row.resource : row.name, ...tail].join('/') };
  }

  async get({ version = 'v1', path, params = {} }) {
    const resolved = await this.path(path, version);
    return this.client.apiRequest({ version, path: resolved.path, params });
  }

  async query({ version = 'v1', entityType, entityId: id, params = {}, limit = 100, offset = 0, allPages = false, maxItems = 5000 }) {
    const resolved = await this.path(`${entityType}${id ? `/${id}` : ''}`, version);
    if (['take', 'skip'].some(key => Object.keys(params).some(k => k.toLowerCase() === key))) {
      throw new TpError('INVALID_PARAMETER', '分页请使用 limit/offset，不能再在 params 中传 take/skip。');
    }
    const items = [];
    let skip = offset;
    for (;;) {
      const data = await this.client.apiRequest({ version, path: resolved.path,
        params: { ...params, take: Math.min(limit, maxItems - items.length), skip } });
      if (version === 'v1' && id && !Array.isArray(data?.Items)) return { entity: data, contentIsUntrusted: true };
      const page = data?.Items ?? data?.items;
      // v2 final selectors return aggregate objects/scalars rather than entity collections.
      if (!Array.isArray(page)) {
        if (allPages) throw new TpError('NOT_A_COLLECTION', '聚合结果不能使用 allPages。');
        return { result: data, contentIsUntrusted: true };
      }
      items.push(...page);
      const hasMore = !!(data.Next || data.next);
      skip += page.length;
      if (!allPages || !hasMore) return { items, hasMore, nextOffset: skip, complete: !hasMore, contentIsUntrusted: true };
      if (!page.length || items.length >= maxItems) throw new TpError('PAGE_LIMIT', '分页异常或达到 maxItems；未返回截断集合冒充全量。');
    }
  }

  async entity(type, id, params = {}) {
    const row = await this.resolve(type);
    const value = await this.client.apiRequest({ path: `${row.resource}/${id}`, params });
    if (value?.Id !== id) throw new TpError('INVALID_RESPONSE', '实体回读编号不匹配。');
    return value;
  }

  async workflow(type, id) {
    const entity = await this.entity(type, id, { include: '[Id,EntityState[Id,Name,NextStates[Id,Name]]]', innerTake: 1000 });
    const state = entity.EntityState;
    if (!state || !Number.isSafeInteger(state.Id)) throw new TpError('NO_WORKFLOW', '该实体没有可用的 EntityState 工作流。');
    const next = state.NextStates;
    if (next?.Next) throw new TpError('WORKFLOW_TRUNCATED', '工作流列表被截断，请核实后再修改。');
    return { entityId: id, currentState: { id: state.Id, name: state.Name }, nextStates: Array.isArray(next) ? next : next?.Items ?? [] };
  }
}

export function validateId(value) {
  if (!entityId.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new TpError('INVALID_ID', '实体编号必须是安全正整数。');
  return Number(value);
}
