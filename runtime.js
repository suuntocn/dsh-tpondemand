import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { tenantOrigin } from './src/config.mjs';
import { TpClient } from './src/client.mjs';
import { registerTools } from './src/server.mjs';

export const SETUP_HINT = '在 DSH 插件 → Targetprocess → 配置中填写 URL 和 Token 并保存。';
// Shared across plugin versions/profiles: never put uncertain-write markers in node_modules.
export const STATE_DIR = join(homedir(), '.dsh-targetprocess', 'state');
export const FILE_TOOLS = new Set(['tp_preview_attachment_upload', 'tp_download_attachment']);
export const APPLY_TOOLS = new Set(['tp_apply_api_changes', 'tp_apply_bug_changes', 'tp_apply_mr_handoff']);

export function connectionConfig(url, token) {
  if (typeof url !== 'string' || typeof token !== 'string') throw new Error('URL 和 Token 必须是字符串。');
  if (Buffer.byteLength(token) > 8192 || /[\x00-\x1f\x7f]/.test(token)) throw new Error('Token 不能包含控制字符，且不得超过 8192 字节。');
  return { origin: url.trim() ? tenantOrigin(url.trim()) : '', token: token.trim(), credentialSource: 'DSH plugin settings' };
}

export function collectTools(config, options = {}) {
  const definitions = new Map();
  const client = new TpClient({ ...config, ...options.clientOptions });
  registerTools({ registerTool(name, definition, handler) {
    definitions.set(name, { ...definition, handler });
  } }, config, client, { stateDir: options.stateDir ?? STATE_DIR });
  return { definitions, client };
}

export function toolCatalog() {
  const { definitions } = collectTools({ origin: 'https://unconfigured.invalid', token: '', credentialSource: 'not_configured' });
  return [...definitions].map(([name, definition]) => ({
    name, description: definition.description, annotations: definition.annotations,
    inputSchema: z.toJSONSchema(definition.inputSchema, { io: 'input', target: 'draft-7' }),
  }));
}

// Each caller retains its own plans. New connection values replace plans rather than retargeting them.
export function createRuntime(readConfig, options = {}) {
  let previous;
  let tools;
  let stopped = false;
  const pending = new Set();
  return {
    async call(name, args, signal) {
      if (stopped || signal?.aborted) throw new Error('Targetprocess 调用已取消。');
      const config = readConfig();
      if (!previous || previous.origin !== config.origin || previous.token !== config.token) {
        previous = config;
        tools = config.origin && config.token ? collectTools(config, options) : undefined;
      }
      if (!tools) {
        if (name === 'tp_connection_status') return { content: [{ type: 'text', text: JSON.stringify({
          connected: false, origin: config.origin || null, tokenConfigured: !!config.token, nextStep: SETUP_HINT,
        }) }] };
        throw new Error(SETUP_HINT);
      }
      const current = tools;
      const tool = current.definitions.get(name);
      if (!tool) throw new Error('Unknown Targetprocess tool.');
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) throw new Error('Targetprocess 参数无效，请按工具参数定义填写。');
      const operation = Promise.resolve().then(() => {
        if (stopped || signal?.aborted) throw new Error('Targetprocess 调用已取消。');
        return tool.handler(parsed.data);
      });
      pending.add(operation);
      try {
        const result = await operation;
        // Sanitize text, not binary/base64 image payloads.
        return { ...result, content: result.content.map(block => block.type === 'text'
          ? { ...block, text: current.client.sanitize(block.text) } : block) };
      } finally { pending.delete(operation); }
    },
    async close() {
      stopped = true;
      // Upstream write recovery must drain; aborting a UI request must not abandon its pending marker.
      await Promise.allSettled([...pending]);
      previous = undefined;
      tools = undefined;
    },
  };
}

export function requiresApproval(name) {
  return APPLY_TOOLS.has(name) || FILE_TOOLS.has(name);
}

export function policyDenial(name, policy) {
  if (FILE_TOOLS.has(name) && policy.mode !== 'danger-full-access') {
    return '附件上传预览/下载会直接访问本机文件；请在明确授权后切换完整文件访问模式。';
  }
  if (APPLY_TOOLS.has(name) && policy.mode === 'read-only') return '只读模式不允许执行 Targetprocess 写入。';
}
