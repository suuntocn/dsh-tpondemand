import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TpError } from './client.mjs';

export const defaultStateDir = fileURLToPath(new URL('../.local-state/', import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
const escapeHtml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function normalizeMr(value) {
  let url;
  try { url = new URL(value); } catch { throw new TpError('INVALID_MR', 'MR 链接无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !/\/-\/merge_requests\/[1-9]\d*\/?$/.test(url.pathname)) {
    throw new TpError('INVALID_MR', '请提供 GitLab MR 页面链接，不可包含凭据、查询参数或片段。');
  }
  return url.href.replace(/\/$/, '');
}

export function hasMr(comments, mr) {
  return comments.some(c => {
    const text = String(c.Description ?? '').replaceAll('&amp;', '&').replaceAll('&#58;', ':').replaceAll('&#47;', '/');
    const urls = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    return urls.some(value => {
      try { return normalizeMr(value) === mr; } catch { return false; }
    });
  });
}

export function summarizeBug(bug, origin) {
  return { id: bug.Id, title: bug.Name, severity: bug.Severity ?? null, state: bug.EntityState, project: bug.Project,
    creator: bug.Owner, createdAt: bug.CreateDate, modifiedAt: bug.ModifyDate,
    url: `${origin}/entity/${bug.Id}` };
}

export function nextStates(bug) {
  const collection = bug.EntityState?.NextStates;
  if (collection?.Next) throw new TpError('WORKFLOW_TRUNCATED', '工作流状态列表被截断，停止写入。');
  return Array.isArray(collection) ? collection : collection?.Items ?? [];
}

export class HandoffService {
  constructor(client, { stateDir = defaultStateDir, now = () => Date.now() } = {}) {
    this.client = client;
    this.stateDir = stateDir;
    this.now = now;
    this.plans = new Map();
  }

  async inspect(id, sourceState, targetState, mrUrl) {
    const bug = await this.client.getBug(id);
    if (bug.Id !== id || !Number.isSafeInteger(bug.EntityState?.Id)) throw new TpError('INVALID_RESPONSE', 'Bug 或状态编号无法确认。');
    const current = bug.EntityState;
    const row = { ...summarizeBug(bug, this.client.origin), sourceStateId: current.Id, targetStateId: current.Id };
    if (current.Name !== sourceState && current.Name !== targetState) return { ...row, action: 'blocked', reason: `当前状态为 ${current.Name}，不符合 ${sourceState} → ${targetState}。` };
    if (current.Name !== targetState) {
      const matches = nextStates(bug).filter(s => s.Name === targetState);
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].Id)) return { ...row, action: 'blocked', reason: '下一步工作流中没有唯一匹配的目标状态。' };
      row.targetStateId = matches[0].Id;
    }
    const comments = await this.client.comments(id);
    return { ...row, action: 'ready', changeState: current.Name !== targetState, addMrComment: !hasMr(comments, mrUrl) };
  }

  async preview({ bugIds, sourceState = 'In Progress', targetState = 'In Testing', mrUrl }) {
    if (sourceState === targetState) throw new TpError('INVALID_STATES', '源状态和目标状态应不同。');
    mrUrl = normalizeMr(mrUrl);
    const ids = [...new Set(bugIds)];
    const results = await mapThree(ids, async id => {
      try { return await this.inspect(id, sourceState, targetState, mrUrl); }
      catch (error) { return { id, action: 'blocked', error: publicError(error) }; }
    });
    for (const [key, plan] of this.plans) if (plan.expiresAt <= this.now()) this.plans.delete(key);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value);
    const planId = randomUUID();
    const plan = { planId, sourceState, targetState, mrUrl, expiresAt: this.now() + 10 * 60 * 1000, results };
    this.plans.set(planId, plan);
    return { ...plan, expiresAt: new Date(plan.expiresAt).toISOString(), mode: 'preview', ready: results.filter(r => r.action === 'ready').length,
      blocked: results.filter(r => r.action === 'blocked').length, note: '预览未写入 TP。执行时会再次核对状态；仅在用户明确要求更新这些 bug 后执行。' };
  }

  async apply(planId) {
    const plan = this.plans.get(planId);
    if (!plan || plan.expiresAt <= this.now()) throw new TpError('PLAN_EXPIRED', '预览不存在或已过期，请重新预览。');
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = resolve(this.stateDir, `${hash(this.client.origin)}.lock`);
    const lock = await acquireLock(lockPath);
    try {
      const results = await mapThree(plan.results, async planned => {
        if (planned.action !== 'ready') return { id: planned.id, outcome: 'skipped', reason: planned.reason ?? planned.error };
        try { return await this.applyOne(planned, plan); }
        catch (error) { return { id: planned.id, outcome: 'failed', error: publicError(error) }; }
      });
      const report = { planId, mrUrl: plan.mrUrl, targetState: plan.targetState, results,
        succeeded: results.filter(r => r.outcome === 'verified').length,
        failed: results.filter(r => r.outcome === 'failed').length,
        skipped: results.filter(r => r.outcome === 'skipped').length,
        note: '每条独立执行，状态和评论并非同一事务。失败项保留实际执行阶段，可重新预览后继续。' };
      const reportPath = resolve(this.stateDir, `report-${Date.now()}-${randomUUID()}.json`);
      try { await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }); report.reportPath = reportPath; }
      catch { report.reportWarning = '本机报告保存失败，实际 TP 结果仍以上述逐条回读为准。'; }
      return report;
    } finally { await lock.close(); await unlink(lockPath); }
  }

  async applyOne(planned, plan) {
    const row = { id: planned.id, url: planned.url, state: 'unchanged', comment: 'unchanged' };
    try {
      const fresh = await this.inspect(planned.id, plan.sourceState, plan.targetState, plan.mrUrl);
      if (fresh.action !== 'ready') return { ...row, outcome: 'skipped', reason: fresh.reason };
      // Refuse workflow remapping or a move to an unrelated state after preview.
      if (fresh.targetStateId !== planned.targetStateId ||
          (fresh.sourceStateId !== planned.sourceStateId && fresh.sourceStateId !== planned.targetStateId)) {
        return { ...row, outcome: 'skipped', reason: '工作流或状态在预览后变化，请重新预览。' };
      }
      if (fresh.changeState) {
        let writeError;
        try { await this.client.setState(planned.id, fresh.targetStateId); }
        catch (error) { writeError = error; }
        const afterState = await this.client.getBug(planned.id);
        if (afterState.EntityState?.Id !== fresh.targetStateId) throw writeError ?? new TpError('STATE_VERIFY_FAILED', '状态回读与目标不一致，未添加评论。');
        row.state = writeError ? 'updated_and_recovered' : 'updated';
      } else row.state = 'already_target';

      const ledgerPath = resolve(this.stateDir, `${hash(`${this.client.origin}|${planned.id}|${plan.mrUrl}`)}.pending`);
      const beforeComment = await this.client.comments(planned.id);
      if (hasMr(beforeComment, plan.mrUrl)) {
        row.comment = 'already_present';
        await unlink(ledgerPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } else {
        // Persist intent before POST. An ambiguous/crashed request may not be replayed blindly.
        try { await writeFile(ledgerPath, JSON.stringify({ bugId: planned.id, startedAt: new Date(this.now()).toISOString() }), { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if (error.code === 'EEXIST') throw new TpError('COMMENT_UNCERTAIN', '上次评论结果待确认，当前未查到 MR 评论。为避免重复，本次不重发；需人工核实后清除本机 pending 记录。');
          throw error;
        }
        let writeError;
        try { await this.client.addComment(planned.id, `MR：\n${escapeHtml(plan.mrUrl)}`); }
        catch (error) { writeError = error; }
        const afterComment = await this.client.comments(planned.id);
        if (!hasMr(afterComment, plan.mrUrl)) {
          // Definite rejection can safely be retried; ambiguous transport failures retain intent.
          if (writeError && writeError.code !== 'WRITE_UNCERTAIN') await unlink(ledgerPath);
          throw writeError ?? new TpError('COMMENT_UNCERTAIN', '评论回读尚未找到 MR 链接，保留待确认记录，不自动重发。');
        }
        row.comment = writeError ? 'added_and_recovered' : 'added';
        await unlink(ledgerPath);
      }
      const final = await this.client.getBug(planned.id);
      if (final.EntityState?.Id !== planned.targetStateId) throw new TpError('FINAL_STATE_CHANGED', '评论已处理，但最终状态发生变化，请核查。');
      return { ...row, outcome: 'verified', finalState: { id: final.EntityState.Id, name: final.EntityState.Name } };
    } catch (error) { return { ...row, outcome: 'failed', error: publicError(error) }; }
  }
}

export function publicError(error) {
  return { code: error instanceof TpError ? error.code : 'INTERNAL', message: error instanceof TpError ? error.message : '本地操作失败，请检查目录访问权限或重新连接。' };
}

export async function acquireLock(path) {
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new TpError('BATCH_BUSY', '另一批 TP 写入正在执行，或上次进程异常退出遗留锁文件。请稍后重试；遗留锁需确认无写入进程后手工清除。');
  }
}

export async function mapThree(values, fn) {
  let next = 0;
  const results = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(3, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}
