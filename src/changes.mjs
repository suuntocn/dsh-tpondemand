import { createHash, randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HandoffService, summarizeBug, nextStates, mapThree, publicError } from './handoff.mjs';
import { TpError } from './client.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export const commentHtml = text => `<p>${escape(text).replaceAll('\n', '<br>')}</p>`;

// Compare text across TP's HTML normalization, never a substring or just an MR URL.
export function commentText(value) {
  return String(value ?? '').replace(/<br\s*\/?\s*>|<\/(?:div|p|li)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, number) => {
      const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }).replace(/&(lt|gt|quot|apos|nbsp|amp);/g, (_, key) => ({ lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' })[key])
    .replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}
export function hasComment(comments, text) {
  const expected = commentText(commentHtml(text));
  return comments.some(comment => commentText(comment.Description) === expected);
}

export class BugChangeService extends HandoffService {
  async inspectChange(change) {
    const bug = await this.client.getBug(change.bugId);
    if (bug.Id !== change.bugId || !Number.isSafeInteger(bug.EntityState?.Id)) throw new TpError('INVALID_RESPONSE', 'Bug 或状态编号无法确认。');
    const current = bug.EntityState;
    const row = { ...summarizeBug(bug, this.client.origin), request: change,
      sourceStateId: current.Id, targetStateId: current.Id, changeState: false, addComment: false };
    if (change.expectedState && current.Name !== change.expectedState && current.Name !== change.targetState) {
      return { ...row, action: 'blocked', reason: `当前状态 ${current.Name} 不符合预期源状态。` };
    }
    if (change.targetState && current.Name !== change.targetState) {
      const matches = nextStates(bug).filter(state => state.Name === change.targetState);
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].Id)) return { ...row, action: 'blocked', reason: '工作流中没有唯一匹配的目标状态。' };
      row.targetStateId = matches[0].Id;
      row.changeState = true;
    }
    if (change.comment !== undefined) row.addComment = !hasComment(await this.client.comments(change.bugId), change.comment);
    return { ...row, action: 'ready' };
  }

  async preview({ changes }) {
    if (new Set(changes.map(change => change.bugId)).size !== changes.length) throw new TpError('DUPLICATE_BUG', '同一计划中每个 bug 只能有一项变更，请合并该条的状态和评论。');
    const results = await mapThree(changes, async change => {
      try { return await this.inspectChange(change); }
      catch (error) { return { id: change.bugId, action: 'blocked', error: publicError(error) }; }
    });
    for (const [id, plan] of this.plans) if (plan.expiresAt <= this.now()) this.plans.delete(id);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value);
    const plan = { planId: randomUUID(), expiresAt: this.now() + 10 * 60 * 1000, results };
    this.plans.set(plan.planId, plan);
    return { ...plan, expiresAt: new Date(plan.expiresAt).toISOString(), mode: 'preview',
      ready: results.filter(row => row.action === 'ready').length,
      blocked: results.filter(row => row.action === 'blocked').length,
      note: '未写入 TP。逐条核对完整评论和状态；仅在用户已明确授权这些动作后执行。' };
  }

  async applyOne(planned) {
    const row = { id: planned.id, url: planned.url, state: 'unchanged', comment: 'not_requested' };
    try {
      const fresh = await this.inspectChange(planned.request);
      if (fresh.action !== 'ready') return { ...row, outcome: 'skipped', reason: fresh.reason };
      if (fresh.targetStateId !== planned.targetStateId ||
        (fresh.sourceStateId !== planned.sourceStateId && fresh.sourceStateId !== planned.targetStateId)) {
        return { ...row, outcome: 'skipped', reason: '预览后状态或工作流发生变化，请重新预览。' };
      }
      if (fresh.changeState) {
        let writeError;
        try { await this.client.setState(planned.id, fresh.targetStateId); } catch (error) { writeError = error; }
        const after = await this.client.getBug(planned.id);
        if (after.EntityState?.Id !== fresh.targetStateId) throw writeError ?? new TpError('STATE_VERIFY_FAILED', '状态回读与目标不一致，未添加评论。');
        row.state = writeError ? 'updated_and_recovered' : 'updated';
      } else if (planned.request.targetState) row.state = 'already_target';

      if (planned.request.comment !== undefined) {
        const text = planned.request.comment;
        const pending = resolve(this.stateDir, `${hash(`${this.client.origin}|${planned.id}|text|${commentText(commentHtml(text))}`)}.pending`);
        if (hasComment(await this.client.comments(planned.id), text)) {
          row.comment = 'already_present';
          await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; });
        } else {
          const before = await this.client.getBug(planned.id);
          if (before.EntityState?.Id !== planned.targetStateId) throw new TpError('STATE_CHANGED', '状态已变化，未发布评论。');
          try { await writeFile(pending, JSON.stringify({ bugId: planned.id, startedAt: new Date(this.now()).toISOString() }), { flag: 'wx', mode: 0o600 }); }
          catch (error) {
            if (error.code === 'EEXIST') throw new TpError('COMMENT_UNCERTAIN', '上次相同评论结果待确认，不重复发送；请先回读核实。');
            throw error;
          }
          let writeError;
          try { await this.client.addComment(planned.id, commentHtml(text)); } catch (error) { writeError = error; }
          const comments = await this.client.comments(planned.id);
          if (!hasComment(comments, text)) {
            if (writeError && writeError.code !== 'WRITE_UNCERTAIN') await unlink(pending);
            throw writeError ?? new TpError('COMMENT_UNCERTAIN', '尚未回读到完整评论，保留待确认记录，不自动重发。');
          }
          row.comment = writeError ? 'added_and_recovered' : 'added';
          row.commentIds = comments.filter(comment => hasComment([comment], text)).map(comment => comment.Id);
          await unlink(pending);
        }
      }
      const final = await this.client.getBug(planned.id);
      if (final.EntityState?.Id !== planned.targetStateId) throw new TpError('FINAL_STATE_CHANGED', '最终状态发生变化，请核查已执行阶段。');
      return { ...row, outcome: 'verified', finalState: { id: final.EntityState.Id, name: final.EntityState.Name } };
    } catch (error) { return { ...row, outcome: 'failed', error: publicError(error) }; }
  }
}
