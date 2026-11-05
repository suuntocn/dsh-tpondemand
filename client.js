window.__ModuleLoader__.load({
  id: '@dyikai/dsh-tpondemand',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'targetprocessSettings'
    const EN = {
      summary: 'Targetprocess tenant address and API token.',
      url: 'Tenant URL',
      urlHint: 'HTTPS only, with no path or /api/v1. Leave empty to disconnect.',
      token: 'API token',
      tokenHint: 'Saved tokens are hidden. Leave blank to keep the saved token, if any.',
      clear: 'Clear the saved token when saving',
      storage: 'Saved locally in the DSH profile configuration. Password masking is not encryption; protect this profile and its backups.',
      save: 'Save', saving: 'Saving…', saved: 'Saved.', discard: 'Discard edits',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is unavailable. Reopen the Plugins page to retry.',
      readOnly: 'This profile is read-only. Changes cannot be saved.',
      stale: 'Configuration changed elsewhere. Discard edits to load the latest values before editing again.',
      rejected: 'Not saved: the Host rejected these changes. Check the values and discard edits if configuration changed elsewhere.',
      failed: 'Could not confirm the save. Reopen this page to check the saved configuration before trying again.',
      urlInvalid: 'Enter an HTTPS tenant address with only / or /api/v1 (optional trailing slash), without user information, query, or fragment.',
      tokenInvalid: 'Enter a non-empty token without spaces or control characters, or leave it blank to preserve the saved token.',
      urlRequired: 'Enter a tenant URL before saving a new token.',
      originChanged: 'The tenant origin changed. Enter a token for this address or explicitly clear the saved token.',
    }
    const ZH = {
      summary: '配置 Targetprocess 租户地址和 API Token。',
      url: '租户 URL',
      urlHint: '仅支持 HTTPS，路径为空或 /api/v1。留空可断开连接。',
      token: 'API Token',
      tokenHint: '已保存的 Token 不会显示。留空保留已有 Token（如有）。',
      clear: '保存时清空已保存的 Token',
      storage: '配置保存在本机 DSH profile 中。密码遮罩不等于加密；请妥善保护该 profile 及其备份。',
      save: '保存', saving: '保存中…', saved: '已保存。', discard: '放弃修改',
      loading: '正在读取配置…',
      unavailable: '配置暂不可用，请重新打开插件页面重试。',
      readOnly: '当前 profile 为只读，无法保存修改。',
      stale: '配置已在其他位置更改。请先放弃修改，读取最新值后重新编辑。',
      rejected: '未保存：Host 拒绝了这些修改。请检查输入；若配置已在其他位置更改，请先放弃修改。',
      failed: '无法确认是否保存成功。请重新打开此页面核对已保存的配置，再决定是否重试。',
      urlInvalid: '请输入 HTTPS 租户地址；路径只能为空、/ 或 /api/v1（可带末尾斜杠），不能包含用户信息、查询参数或片段。',
      tokenInvalid: '请输入不含空格或控制字符的非空 Token，或留空保留已有 Token。',
      urlRequired: '保存新 Token 前，请先输入租户 URL。',
      originChanged: '租户来源已更改。请重新输入此地址的 Token，或明确选择清空已有 Token。',
    }
    const muted = { margin: 0, color: 'var(--dsw-alias-label-secondary)' }
    const errorStyle = { margin: 0, color: 'var(--dsw-alias-state-error-primary)' }
    const control = {
      boxSizing: 'border-box', minHeight: 44, padding: '8px 12px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)', font: 'inherit',
    }
    const column = { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }

    function tenantOrigin(value) {
      if (value === '') return ''
      // Check the raw path too: URL parsing normalizes dot segments and backslashes.
      if (!/^https:\/\/[^/?#@\\\s]+(?:\/(?:api\/v1\/?)?)?$/i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null
      try {
        const url = new URL(value)
        return ['/', '/api/v1', '/api/v1/'].includes(url.pathname) ? url.origin : null
      } catch { return null }
    }

    function mutation(draft, revision) {
      if (draft.revision !== revision) return { error: 'stale' }
      const url = draft.url.trim()
      const origin = tenantOrigin(url)
      if (origin === null) return { error: 'urlInvalid' }
      if (!draft.clear && /[\s\u0000-\u001f\u007f]/.test(draft.token)) return { error: 'tokenInvalid' }
      if (!draft.clear && draft.token && !url) return { error: 'urlRequired' }
      if (origin !== tenantOrigin(draft.baseUrl.trim()) && !draft.clear && !draft.token) return { error: 'originChanged' }
      const ops = []
      if (url !== draft.baseUrl) ops.push({ op: 'set', path: ['url'], value: url })
      // Never restate a redacted secret or unset it (which can reveal an inherited value).
      if (draft.clear || draft.token) ops.push({ op: 'set', path: ['token'], value: draft.clear ? '' : draft.token })
      return { ops }
    }

    function Editor({ form, t }) {
      const state = form.state
      const savedUrl = typeof state.value?.url === 'string' ? state.value.url : ''
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const busy = React.useRef(false)
      const urlRef = React.useRef(null)
      const tokenRef = React.useRef(null)
      const id = React.useId()
      const current = draft || { url: savedUrl, baseUrl: savedUrl, token: '', clear: false, revision: state.revision }
      const stale = draft !== null && draft.revision !== state.revision
      const saving = notice === 'saving'
      const disabled = !state.writable || saving || stale || notice === 'failed'
      const dirty = current.url !== current.baseUrl || current.token !== '' || current.clear
      const urlError = notice === 'urlInvalid' || notice === 'urlRequired'
      const tokenError = notice === 'tokenInvalid' || notice === 'originChanged'
      const originChanged = tenantOrigin(current.url.trim()) !== tenantOrigin(current.baseUrl.trim())
      const edit = (patch) => {
        if (disabled || busy.current) return
        setDraft((previous) => ({ ...(previous || current), ...patch }))
        setNotice('')
      }
      const save = async (event) => {
        event.preventDefault()
        if (disabled || busy.current || !dirty) return
        const result = mutation(current, state.revision)
        if (result.error) {
          setNotice(result.error)
          if (result.error === 'urlInvalid' || result.error === 'urlRequired') urlRef.current?.focus()
          else tokenRef.current?.focus()
          return
        }
        if (result.ops.length === 0) { setDraft(null); return }
        busy.current = true
        setNotice('saving')
        try {
          if (await form.mutate(result.ops, current.revision)) {
            setDraft(null)
            setNotice('saved')
          } else setNotice('rejected')
        } catch {
          // Transport errors can contain submitted values; never render or log them.
          setDraft(null)
          setNotice('failed')
        } finally { busy.current = false }
      }
      const status = saving ? 'saving' : stale ? 'stale' : notice
      const isError = ['stale', 'rejected', 'failed'].includes(status)
      return h('form', { onSubmit: save, noValidate: true, autoComplete: 'off', style: { ...column, gap: 16, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' } },
        h('p', { style: muted }, t('storage')),
        !state.writable ? h('p', { role: 'status', style: muted }, t('readOnly')) : null,
        h('div', { style: column },
          h('label', { htmlFor: `${id}-url` }, t('url')),
          h('input', {
            id: `${id}-url`, ref: urlRef, type: 'url', value: current.url, disabled,
            autoComplete: 'off', autoCapitalize: 'none', spellCheck: false,
            'aria-invalid': urlError, 'aria-describedby': `${id}-url-help`,
            style: { ...control, width: '100%' },
            onChange: (event) => {
              const url = event.target.value
              const changed = tenantOrigin(url.trim()) !== tenantOrigin(current.url.trim())
              edit({ url, ...(changed ? { token: '' } : {}) })
            },
          }),
          h('p', { id: `${id}-url-help`, role: urlError ? 'alert' : undefined, style: urlError ? errorStyle : muted }, t(urlError ? notice : 'urlHint')),
        ),
        h('div', { style: column },
          h('label', { htmlFor: `${id}-token` }, t('token')),
          h('input', {
            id: `${id}-token`, ref: tokenRef, type: 'password', value: current.token, disabled: disabled || current.clear,
            autoComplete: 'new-password', autoCapitalize: 'none', spellCheck: false,
            'aria-invalid': tokenError, 'aria-describedby': `${id}-token-help`,
            style: { ...control, width: '100%' }, onChange: (event) => edit({ token: event.target.value }),
          }),
          h('p', { id: `${id}-token-help`, role: tokenError ? 'alert' : undefined, style: tokenError ? errorStyle : muted }, t(tokenError ? notice : originChanged && !current.clear && !current.token ? 'originChanged' : 'tokenHint')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 } },
            h('input', { type: 'checkbox', checked: current.clear, disabled, onChange: (event) => edit({ clear: event.target.checked, token: '' }) }),
            t('clear'),
          ),
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } },
          h('button', { type: 'submit', disabled: disabled || !dirty, 'aria-busy': saving, style: control }, t(saving ? 'saving' : 'save')),
          h('button', { type: 'button', disabled: !draft || saving, style: control, onClick: () => { setDraft(null); setNotice('') } }, t('discard')),
        ),
        h('p', { role: isError ? 'alert' : 'status', style: isError ? errorStyle : muted }, status && (isError || (!urlError && !tokenError)) ? t(status) : ''),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN))
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH))
        const translate = ctx.locale.bind(NS)
        function ConfigPage({ view, form, t = translate }) {
          if (view === 'summary') return h('span', null, t('summary'))
          if (!form) return h('p', { role: 'status', style: muted }, t('unavailable'))
          const state = form.state
          if (!state || state.status === 'loading') return h('p', { role: 'status', style: muted }, t('loading'))
          if (state.status !== 'ready' || !Number.isSafeInteger(state.revision)) return h('p', { role: 'alert', style: errorStyle }, t('unavailable'))
          return h(Editor, { form, t })
        }
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@dyikai/dsh-tpondemand#targetprocess', locale: NS,
        }, ConfigPage))
      },
    }
  },
})
