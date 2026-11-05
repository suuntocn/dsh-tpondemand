export function tenantOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL 必须是有效的 HTTPS 租户地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['/', '/api/v1', '/api/v1/'].includes(url.pathname)) {
    throw new Error('URL 只允许 HTTPS 租户地址，不可含凭据、查询参数或自定义路径。');
  }
  return url.origin;
}

// Standalone protocol tests may inject an environment; the DSH plugin never calls this.
export async function loadConfig(env = process.env) {
  const origin = tenantOrigin(env.TP_BASE_URL);
  const token = env.TP_ACCESS_TOKEN?.trim();
  return { origin, token, credentialSource: token ? 'environment' : 'not_configured' };
}
