// @local/dsh-krun-vm 客户端半：管理页（settings.section）+ 状态芯片（conversation.input.left）。
window.__ModuleLoader__.load({
  id: '@local/dsh-krun-vm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const stylesCss = `
.krun-page { display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: var(--dsw-alias-fg-primary); }
.krun-card { border: 1px solid var(--dsw-alias-border-secondary); border-radius: 8px; padding: 12px; }
.krun-card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.krun-row { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; }
.krun-muted { color: var(--dsw-alias-fg-secondary); }
.krun-btn { border: 1px solid var(--dsw-alias-border-primary); border-radius: 6px; background: transparent; color: var(--dsw-alias-fg-primary); padding: 2px 10px; cursor: pointer; font-size: 12px; }
.krun-btn:hover { background: var(--dsw-alias-bg-secondary); }
.krun-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-fg-secondary); border: 1px solid var(--dsw-alias-border-secondary); border-radius: 999px; padding: 1px 8px; }
`;
    const STYLES_TAG_ID = '@local/dsh-krun-vm/client.css';
    // 官方模式：手动插 <style data-plugin-css> 标签（loader 无 'styles' require 目标，
    // require('styles') 会抛错并使整个 client 模块静默失败）。
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css="${STYLES_TAG_ID}"]`)) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-krun-vm';
      tag.dataset.pluginCss = STYLES_TAG_ID;
      tag.textContent = stylesCss;
      document.head.appendChild(tag);
    }

    async function fetchStatus() {
      try {
        const r = await fetch('/api/krun/status');
        return await r.json();
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    }

    function ManagementPage() {
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const refresh = React.useCallback(async () => {
        setBusy(true);
        setStatus(await fetchStatus());
        setBusy(false);
      }, []);
      React.useEffect(() => { refresh(); }, [refresh]);
      const stopSession = async (key) => {
        await fetch('/api/krun/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
        refresh();
      };
      const reprobe = async () => {
        await fetch('/api/krun/probe', { method: 'POST' });
        refresh();
      };
      const probe = status?.probe;
      const sessions = status?.sessions ?? [];
      return h('div', { className: 'krun-page' },
        h('div', { className: 'krun-card' },
          h('div', { className: 'krun-row' },
            h('h3', null, '环境体检'),
            h('button', { className: 'krun-btn', onClick: reprobe, disabled: busy }, '重测')),
          probe
            ? h('div', null,
                h('div', { className: 'krun-row' }, h('span', null, '状态'), h('span', { className: probe.ok ? 'krun-muted' : 'krun-muted' }, probe.ok ? '可用' : `不可用：${probe.detail}`)))
            : h('div', { className: 'krun-muted' }, '尚未探测')),
        h('div', { className: 'krun-card' },
          h('div', { className: 'krun-row' },
            h('h3', null, '运行会话'),
            h('button', { className: 'krun-btn', onClick: refresh, disabled: busy }, '刷新')),
          sessions.length === 0
            ? h('div', { className: 'krun-muted' }, '无（惰性启动：首个受限命令时创建）')
            : sessions.map((s) => h('div', { className: 'krun-row', key: s.key },
                h('span', null, `${s.mode} · ${s.ws}`),
                h('span', null,
                  `${Math.round(s.uptimeMs / 1000)}s `,
                  h('button', { className: 'krun-btn', onClick: () => stopSession(s.key), disabled: !s.alive }, '停止')))),
          h('div', { className: 'krun-row krun-muted' },
            h('span', null, `镜像：${status?.config?.imageRootfs || '(未配置)'}`),
            h('span', null, `空闲回收：${(status?.config?.idleStopMs ?? 0) / 1000}s`))),
      );
    }

    function StatusChip() {
      const [sessions, setSessions] = React.useState(null);
      React.useEffect(() => {
        let stop = false;
        const tick = async () => {
          const st = await fetchStatus();
          if (!stop) setSessions(st?.sessions ?? []);
        };
        tick();
        const t = setInterval(tick, 10000);
        return () => { stop = true; clearInterval(t); };
      }, []);
      if (!sessions || sessions.length === 0) return null;
      return h('div', { className: 'krun-chip', title: 'libkrun VM 会话' }, `VM ×${sessions.length}`);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'krun-vm', order: 90, label: 'VM sandbox' },
          ManagementPage,
        ));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'krun-vm-status', order: 20 },
          StatusChip,
        ));
      },
    };
  },
});
