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
.krun-input { border: 1px solid var(--dsw-alias-border-secondary); border-radius: 6px; background: transparent; color: var(--dsw-alias-fg-primary); padding: 2px 8px; font-size: 12px; min-width: 0; flex: 1; }
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

    async function postJson(path, body) {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      let data = {};
      try { data = await r.json(); } catch { /* 非 JSON 响应按空处理 */ }
      return { status: r.status, ...data };
    }

    const fmtMib = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)}MiB` : '?');

    // 内置镜像预设（均经导入 + 引导实测；URL 以发布页为准）
    const IMAGE_PRESETS = [
      { name: 'alpine-minirootfs-3.22', url: 'https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64/alpine-minirootfs-3.22.0-x86_64.tar.gz' },
      { name: 'ubuntu-base-24.04', url: 'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04.3/release/ubuntu-base-24.04.3-base-amd64.tar.gz' },
    ];

    function ImportForm({ onMsg, refresh }) {
      const [kind, setKind] = React.useState('url');
      const [src, setSrc] = React.useState('');
      const [name, setName] = React.useState('');
      const applyPreset = (id) => {
        const p = IMAGE_PRESETS.find((x) => x.name === id);
        if (!p) return;
        setKind('url');
        setSrc(p.url);
        setName(p.name);
      };
      const submit = async () => {
        const body = { kind, name: name || undefined };
        if (kind === 'container') body.container = src;
        else if (kind === 'url') body.url = src;
        else body.path = src;
        const r = await postJson('/api/krun/images/import', body);
        onMsg(r.ok ? `导入任务已提交：${r.jobId}` : `导入失败：${r.err ?? r.status}`);
        refresh();
      };
      return h('div', null,
        h('div', { className: 'krun-row' },
          h('select', { className: 'krun-btn', value: '', onChange: (e) => applyPreset(e.target.value) },
            h('option', { value: '' }, '预设（已测）…'),
            IMAGE_PRESETS.map((p) => h('option', { key: p.name, value: p.name }, p.name)))),
        h('div', { className: 'krun-row' },
          h('select', { className: 'krun-btn', value: kind, onChange: (e) => setKind(e.target.value) },
            h('option', { value: 'url' }, 'URL'),
            h('option', { value: 'tarball' }, 'tarball'),
            h('option', { value: 'dir' }, '目录'),
            h('option', { value: 'container' }, '容器导出')),
          h('input', {
            className: 'krun-input',
            placeholder: kind === 'container' ? '容器名（docker/podman export）' : kind === 'url' ? 'https://…/rootfs.tar.gz' : '/绝对路径',
            value: src,
            onChange: (e) => setSrc(e.target.value),
          }),
          h('input', { className: 'krun-input', placeholder: '名称（可选）', value: name, onChange: (e) => setName(e.target.value) }),
          h('button', { className: 'krun-btn', onClick: submit }, '导入')));
    }

    function BindForm({ images, onMsg, refresh }) {
      const [ws, setWs] = React.useState('');
      const [imageId, setImageId] = React.useState('');
      const submit = async () => {
        const r = await postJson('/api/krun/workspaces/bind', { ws, imageId });
        onMsg(r.ok ? `已绑定 ${ws} → ${imageId}` : `绑定失败：${r.err ?? r.status}`);
        refresh();
      };
      return h('div', { className: 'krun-row' },
        h('input', { className: 'krun-input', placeholder: '/工作区/绝对路径', value: ws, onChange: (e) => setWs(e.target.value) }),
        h('select', { className: 'krun-btn', value: imageId, onChange: (e) => setImageId(e.target.value) },
          h('option', { value: '' }, '选择镜像…'),
          images.map((im) => h('option', { key: im.id, value: im.id }, `${im.name} (${im.id})`))),
        h('button', { className: 'krun-btn', onClick: submit, disabled: !ws || !imageId }, '绑定'));
    }

    function ManagementPage() {
      const [status, setStatus] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const refresh = React.useCallback(async () => {
        setBusy(true);
        setStatus(await fetchStatus());
        setBusy(false);
      }, []);
      React.useEffect(() => { refresh(); }, [refresh]);
      // 导入任务运行中：3s 轮询进度（任务结束自动停回手动刷新）
      const hasRunningJob = (status?.jobs ?? []).some((j) => j.status === 'running');
      React.useEffect(() => {
        if (!hasRunningJob) return undefined;
        const t = setInterval(refresh, 3000);
        return () => clearInterval(t);
      }, [hasRunningJob, refresh]);
      const stopSession = async (key) => {
        await postJson('/api/krun/stop', { key });
        refresh();
      };
      const reprobe = async () => {
        await postJson('/api/krun/probe');
        refresh();
      };
      const deleteImage = async (id) => {
        const r = await postJson('/api/krun/images/delete', { id });
        setMsg(r.ok ? `镜像已删除：${id}` : `删除失败：${r.err ?? r.status}`);
        refresh();
      };
      const unbind = async (ws) => {
        const r = await postJson('/api/krun/workspaces/unbind', { ws });
        setMsg(r.ok ? `已解绑 ${ws}` : `解绑失败：${r.err ?? r.status}`);
        refresh();
      };
      const resetWs = async (ws) => {
        const r = await postJson('/api/krun/workspaces/reset', { ws });
        setMsg(r.ok ? `已重置 ${ws}（停 ${r.stopped?.length ?? 0} 会话，删 ${r.removed?.length ?? 0} 数据层）` : `重置失败：${r.err ?? r.status}`);
        refresh();
      };
      const probe = status?.probe;
      const sessions = status?.sessions ?? [];
      const images = status?.images ?? [];
      const workspaces = status?.workspaces ?? {};
      const jobs = (status?.jobs ?? []).filter((j) => j.status !== 'done').slice(-3);
      const imageById = Object.fromEntries(images.map((im) => [im.id, im]));
      return h('div', { className: 'krun-page' },
        h('div', { className: 'krun-card' },
          h('div', { className: 'krun-row' },
            h('h3', null, '环境体检'),
            h('button', { className: 'krun-btn', onClick: reprobe, disabled: busy }, '重测')),
          probe
            ? h('div', null,
                h('div', { className: 'krun-row' }, h('span', null, '状态'), h('span', { className: 'krun-muted' }, probe.ok ? '可用' : `不可用：${probe.detail}`)))
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
                  `${Math.round(s.uptimeMs / 1000)}s · 空闲 ${Math.round((s.idleMs ?? 0) / 1000)}s `,
                  h('button', { className: 'krun-btn', onClick: () => stopSession(s.key), disabled: !s.alive }, '停止')))),
          h('div', { className: 'krun-row krun-muted' },
            h('span', null, `默认镜像：${status?.config?.imageRootfs || '(未配置，仅导入镜像)'}`),
            h('span', null, `空闲回收：${(status?.config?.idleStopMs ?? 0) / 1000}s · ${status?.config?.network === 'none' ? 'network=none' : 'network=tsi'}`))),
        h('div', { className: 'krun-card' },
          h('div', { className: 'krun-row' }, h('h3', null, '镜像')),
          images.length === 0
            ? h('div', { className: 'krun-muted' }, '无导入镜像（工作区默认使用 imageRootfs）')
            : images.map((im) => h('div', { className: 'krun-row', key: im.id },
                h('span', null, `${im.name} · ${im.arch} · ${fmtMib(im.sizeBytes)}${im.bashReady === false ? ' · 无 bash' : ''}`),
                h('span', null,
                  `引用 ${im.refCount} `,
                  h('button', { className: 'krun-btn', onClick: () => deleteImage(im.id), disabled: im.refCount > 0 }, '删除')))),
          jobs.map((j) => h('div', { className: 'krun-row krun-muted', key: j.id },
            h('span', null, `导入 ${j.label}…`), h('span', null, j.status))),
          h(ImportForm, { onMsg: setMsg, refresh }),
          h('div', { className: 'krun-row krun-muted' }, h('span', null, msg))),
        h('div', { className: 'krun-card' },
          h('div', { className: 'krun-row' }, h('h3', null, '工作区绑定')),
          Object.keys(workspaces).length === 0
            ? h('div', { className: 'krun-muted' }, '无绑定（全部工作区用默认镜像）')
            : Object.entries(workspaces).map(([ws, b]) => h('div', { className: 'krun-row', key: ws },
                h('span', null, `${ws} → ${imageById[b.imageId]?.name ?? b.imageId}`),
                h('span', null,
                  h('button', { className: 'krun-btn', onClick: () => unbind(ws) }, '解绑'),
                  ' ',
                  h('button', { className: 'krun-btn', onClick: () => resetWs(ws) }, '重置数据层')))),
          h(BindForm, { images, onMsg: setMsg, refresh })),
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
