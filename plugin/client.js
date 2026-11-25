// @local/dsh-krun-vm 客户端半：管理页（settings.section）+ 状态芯片（conversation.input.left）。
window.__ModuleLoader__.load({
  id: '@local/dsh-krun-vm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const stylesCss = `
.krun-page { display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.krun-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px; }
.krun-card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.krun-row { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; }
.krun-muted { color: var(--dsw-alias-label-secondary); }
.krun-btn { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); padding: 2px 10px; cursor: pointer; font-size: 12px; }
.krun-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.krun-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 1px 8px; }
.krun-input { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); padding: 6px 8px; font-size: 12px; min-width: 0; flex: 1; }
.krun-panel { display:flex; flex-direction:column; height:100%; min-height:0; overflow:auto; padding:24px; gap:16px; color:var(--dsw-alias-label-primary); }
.krun-panel-head h1 { margin:0; font-size:20px; }
.krun-panel-head p { margin:6px 0 0; }
.krun-tabs { display:flex; gap:8px; flex-wrap:wrap; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:10px; }
.krun-tab-active { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
.krun-field { display:flex; flex-direction:column; gap:5px; margin:10px 0; }
.krun-file-list { max-height:40vh; overflow:auto; }
.krun-file-name { border:0; background:transparent; color:var(--dsw-alias-label-primary); text-align:left; cursor:pointer; min-width:0; flex:1; padding:6px; overflow-wrap:anywhere; }
.krun-file-editor { margin-top:12px; }
.krun-file-input { position:absolute; width:1px; height:1px; opacity:0; }
.krun-editor { width:100%; min-height:240px; resize:vertical; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:6px; padding:10px; font:12px/1.5 monospace; }
.krun-btn:focus-visible,.krun-file-name:focus-visible,.krun-input:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
@media (max-width: 700px) { .krun-panel { padding:14px; } .krun-row { flex-wrap:wrap; } }
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
    const toBase64 = (bytes) => { let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); };

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
      const [network, setNetwork] = React.useState('');
      const submit = async () => {
        const r = await postJson('/api/krun/workspaces/bind', { ws, imageId, network: network || undefined });
        onMsg(r.ok ? `已绑定 ${ws} → ${imageId}${network ? `（网络 ${network}）` : ''}` : `绑定失败：${r.err ?? r.status}`);
        refresh();
      };
      const create = async () => {
        const r = await postJson('/api/krun/create', { ws, imageId, network: network || undefined, mode: 'rw' });
        onMsg(r.ok ? `已创建并启动 VM：${r.key} · ${imageId}` : `创建 VM 失败：${r.err ?? r.status}`);
        refresh();
      };
      return h('div', null,
        h('div', { className: 'krun-row' },
          h('input', { className: 'krun-input', placeholder: '/工作区/绝对路径', value: ws, onChange: (e) => setWs(e.target.value) }),
          h('select', { className: 'krun-btn', value: imageId, onChange: (e) => setImageId(e.target.value) },
            h('option', { value: '' }, '选择镜像…'),
            images.map((im) => h('option', { key: im.id, value: im.id }, `${im.name} (${im.id})`))),
          h('button', { className: 'krun-btn', onClick: submit, disabled: !ws || !imageId }, '绑定'),
          h('button', { className: 'krun-btn', onClick: create, disabled: !ws || !imageId }, '绑定并启动 VM')),
        h('div', { className: 'krun-row krun-muted' },
          h('span', null, '网络档：'),
          h('select', { className: 'krun-btn', value: network, onChange: (e) => setNetwork(e.target.value) },
            h('option', { value: '' }, '跟随全局默认'),
            h('option', { value: 'tsi' }, 'tsi（共享宿主网络）'),
            h('option', { value: 'none' }, 'none（隔离）')),
          h('span', null, '档位变化在下次会话（重）建时生效')));
    }

    function DnsSettings({ status, onMsg, refresh }) {
      const [servers, setServers] = React.useState('');
      const configured = status?.config?.dnsServers ?? [];
      const configuredKey = configured.join(', ');
      React.useEffect(() => setServers(configuredKey), [configuredKey]);
      const save = async () => {
        const r = await postJson('/api/krun/dns', { dnsServers: servers });
        onMsg(r.ok
          ? `DNS 设置已保存${r.dnsServers.length ? `：${r.dnsServers.join(', ')}` : '：自动使用宿主 DNS'}；运行中的 VM 已停止，下次启动生效。`
          : `DNS 设置失败：${r.err ?? r.status}`);
        if (r.ok) refresh();
      };
      return h('div', { className: 'krun-card' },
        h('h3', null, 'DNS 设置'),
        h('p', { className: 'krun-muted' }, '填写 DNS 服务器 IP，多个地址用逗号分隔；留空则自动使用宿主机 resolv.conf 中的 DNS。VM 启动时写入 /etc/resolv.conf，并使用 TCP DNS 以兼容 TSI。保存后会停止现有 VM，会话下次启动时生效。'),
        h('div', { className: 'krun-row' },
          h('input', { className: 'krun-input', 'aria-label': 'DNS 服务器', placeholder: '例如 1.1.1.1, 8.8.8.8', value: servers, onChange: (e) => setServers(e.target.value) }),
          h('button', { className: 'krun-btn', onClick: save }, '保存 DNS')));
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
                h('span', null, `${s.mode} · 网络 ${s.network ?? '默认'} · ${s.ws}`),
                h('span', null,
                  `${Math.round(s.uptimeMs / 1000)}s · 空闲 ${Math.round((s.idleMs ?? 0) / 1000)}s `,
                  h('button', { className: 'krun-btn', onClick: () => stopSession(s.key), disabled: !s.alive }, '停止')))),
          h('div', { className: 'krun-row krun-muted' },
            h('span', null, `默认镜像：${status?.config?.imageRootfs || '(未配置，仅导入镜像)'}`),
            h('span', null, `空闲回收：${(status?.config?.idleStopMs ?? 0) / 1000}s · ${status?.config?.network === 'none' ? 'network=none' : 'network=tsi'}`))),
        h(DnsSettings, { status, onMsg: setMsg, refresh }),
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
                h('span', { style: { flex: 1 } }, `${ws} → ${imageById[b.imageId]?.name ?? b.imageId}`),
                h('select', {
                  className: 'krun-btn',
                  value: b.network ?? '',
                  onChange: async (e) => {
                    const r = await postJson('/api/krun/workspaces/network', { ws, network: e.target.value });
                    setMsg(r.ok ? `${ws} 网络档 → ${e.target.value || '默认'}（下次会话重建生效）` : `设置失败：${r.err ?? r.status}`);
                    refresh();
                  },
                },
                  h('option', { value: '' }, '默认'),
                  h('option', { value: 'tsi' }, 'tsi'),
                  h('option', { value: 'none' }, 'none')),
                h('button', { className: 'krun-btn', onClick: () => unbind(ws) }, '解绑'),
                h('button', { className: 'krun-btn', onClick: () => resetWs(ws) }, '重置数据层'))),
          h(BindForm, { images, onMsg: setMsg, refresh })),
      );
    }

    function VmFiles() {
      const [status, setStatus] = React.useState(null);
      const [key, setKey] = React.useState('');
      const [path, setPath] = React.useState('');
      const [entries, setEntries] = React.useState([]);
      const [opened, setOpened] = React.useState(null);
      const [fileName, setFileName] = React.useState('');
      const [newFolder, setNewFolder] = React.useState('');
      const [renameTo, setRenameTo] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const load = async (nextPath = path, nextKey = key) => {
        setBusy(true);
        const r = await postJson('/api/krun/files', { key: nextKey, action: 'list', path: nextPath });
        setBusy(false);
        if (!r.ok) { setMessage(r.err || '读取失败'); return; }
        setEntries(r.result ?? []); setPath(nextPath); setMessage('');
      };
      React.useEffect(() => { fetchStatus().then((s) => { setStatus(s); const first = s.sessions?.[0]?.key ?? ''; setKey(first); if (first) load('', first); }); }, []);
      const sessions = status?.sessions ?? [];
      const openFile = async (entry) => {
        if (entry.type === 'dir') { await load(`${path ? `${path}/` : ''}${entry.name}`); return; }
        const p = `${path ? `${path}/` : ''}${entry.name}`;
        const r = await postJson('/api/krun/files', { key, action: 'read', path: p });
        if (!r.ok) { setMessage(r.err); return; }
        const bytes = Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0));
        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary files stay downloadable without text editing */ }
        setOpened({ path: p, text, data: r.result.data });
        setFileName(entry.name);
      };
      const operate = async (action, values = {}) => {
        const r = await postJson('/api/krun/files', { key, action, path: values.path ?? path, ...values });
        setMessage(r.ok ? '操作已完成' : `操作失败：${r.err ?? r.status}`);
        if (r.ok) { setOpened(null); await load(path); }
      };
      const download = () => {
        const bytes = Uint8Array.from(atob(opened.data), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes]);
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName; a.click(); URL.revokeObjectURL(a.href);
      };
      const upload = async (e) => {
        const f = e.target.files?.[0]; if (!f || f.size > 64 * 1024) { setMessage('文件不能超过 64 KiB'); return; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        await operate('write', { path: `${path ? `${path}/` : ''}${f.name}`, data: toBase64(bytes), overwrite: true });
        e.target.value = '';
      };
      const active = sessions.find((s) => s.key === key);
      return h('div', { className: 'krun-page' },
        h('div', { className: 'krun-card' }, h('h3', null, '虚拟机文件'),
          h('label', { className: 'krun-field' }, '运行会话', h('select', { className: 'krun-input', value: key, onChange: (e) => { setKey(e.target.value); load(path, e.target.value); } }, sessions.map((s) => h('option', { key: s.key, value: s.key }, `${s.ws} · ${s.mode}`)))),
          active ? h('p', { className: 'krun-muted' }, '仅访问 VM 内 /root/vm-files；单文件上限 64 KiB。') : h('p', { className: 'krun-muted' }, '没有正在运行的 VM。请先在概览中启动会话。'),
          h('div', { className: 'krun-row' }, h('button', { className: 'krun-btn', disabled: !active || !path, onClick: () => load(path.split('/').slice(0, -1).join('/')) }, '上级'), h('code', null, `/ ${path}`), h('button', { className: 'krun-btn', disabled: !active || busy, onClick: () => load() }, '刷新')),
          h('div', { className: 'krun-file-list' }, entries.map((entry) => h('div', { className: 'krun-row', key: entry.name },
            h('button', { className: 'krun-file-name', onClick: () => openFile(entry) }, `${entry.type === 'dir' ? '▸ ' : ''}${entry.name}`), h('span', { className: 'krun-muted' }, entry.type === 'dir' ? '目录' : fmtMib(entry.size)),
            h('button', { className: 'krun-btn', disabled: !active, onClick: () => operate('remove', { path: `${path ? `${path}/` : ''}${entry.name}` }) }, '删除')))),
          h('div', { className: 'krun-row' }, h('label', { className: 'krun-btn' }, '上传文件', h('input', { className: 'krun-file-input', type: 'file', disabled: !active, onChange: upload })), h('input', { className: 'krun-input', 'aria-label': '新建目录名称', value: newFolder, onChange: (e) => setNewFolder(e.target.value), placeholder: '新目录名称' }), h('button', { className: 'krun-btn', disabled: !active || !newFolder, onClick: () => operate('mkdir', { path: `${path ? `${path}/` : ''}${newFolder}` }).then(() => setNewFolder('')) }, '新建目录')),
          opened && h('div', { className: 'krun-file-editor' }, h('div', { className: 'krun-row' }, h('strong', null, opened.path), h('button', { className: 'krun-btn', onClick: download }, '下载'), h('input', { className: 'krun-input', 'aria-label': '重命名为', value: renameTo, onChange: (e) => setRenameTo(e.target.value), placeholder: '新名称' }), h('button', { className: 'krun-btn', disabled: !renameTo, onClick: () => operate('rename', { path: opened.path, to: `${path ? `${path}/` : ''}${renameTo}` }).then(() => setRenameTo('')) }, '重命名'), opened.text !== null && h('button', { className: 'krun-btn', onClick: () => operate('write', { path: opened.path, data: toBase64(new TextEncoder().encode(opened.text)), overwrite: true }) }, '保存'), h('button', { className: 'krun-btn', onClick: () => setOpened(null) }, '关闭')), opened.text !== null ? h('textarea', { className: 'krun-editor', 'aria-label': `编辑 ${opened.path}`, value: opened.text, onChange: (e) => setOpened({ ...opened, text: e.target.value }) }) : h('p', { className: 'krun-muted' }, '二进制文件：可下载，但不提供文本编辑。')),
          h('div', { className: 'krun-muted', role: 'status', 'aria-live': 'polite' }, message)));
    }

    function VmMounts() {
      const [status, setStatus] = React.useState(null);
      const [ws, setWs] = React.useState('');
      const [name, setName] = React.useState('shared');
      const [path, setPath] = React.useState('');
      const [message, setMessage] = React.useState('');
      const refresh = () => fetchStatus().then(setStatus);
      React.useEffect(() => { refresh(); }, []);
      const workspaces = status?.workspaces ?? {};
      const update = async (workspace, mounts) => {
        const r = await postJson('/api/krun/workspaces/mounts', { ws: workspace, mounts });
        setMessage(r.ok ? `目录挂载已更新；该工作区 VM 已停止，下一次使用时将重新启动。` : `更新失败：${r.err ?? r.status}`); refresh();
      };
      return h('div', { className: 'krun-page' },
        h('div', { className: 'krun-card' }, h('h3', null, '附加宿主目录'), h('p', { className: 'krun-muted' }, '附加目录只读挂载到 VM 的 /mnt/dsh-shares/<名称>。只读由宿主 virtiofs 强制；不要选择敏感目录。'),
          h('label', { className: 'krun-field' }, '工作区绝对路径', h('input', { className: 'krun-input', value: ws, onChange: (e) => setWs(e.target.value), placeholder: '/home/user/project' })),
          h('label', { className: 'krun-field' }, '挂载名称', h('input', { className: 'krun-input', value: name, onChange: (e) => setName(e.target.value), pattern: '[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}' })),
          h('label', { className: 'krun-field' }, '宿主目录绝对路径', h('input', { className: 'krun-input', value: path, onChange: (e) => setPath(e.target.value), placeholder: '/data/reference' })),
          h('button', { className: 'krun-btn', disabled: !ws.startsWith('/') || !path.startsWith('/') || !name, onClick: () => update(ws, [...(workspaces[ws]?.mounts ?? []), { name, path }]) }, '添加只读挂载')),
        Object.entries(workspaces).map(([workspace, binding]) => h('div', { className: 'krun-card', key: workspace }, h('h3', null, workspace),
          h('div', { className: 'krun-row' }, h('span', null, '网络'), h('select', { className: 'krun-input', 'aria-label': `${workspace} 网络模式`, value: binding.network ?? '', onChange: async (e) => { const r = await postJson('/api/krun/workspaces/network', { ws: workspace, network: e.target.value }); setMessage(r.ok ? `网络配置已更新：${e.target.value || '默认'}` : r.err); refresh(); } }, h('option', { value: '' }, '全局默认'), h('option', { value: 'tsi' }, 'tsi · 共享网络'), h('option', { value: 'none' }, 'none · 隔离网络'))),
          (binding.mounts ?? []).map((m) => h('div', { className: 'krun-row', key: m.name }, h('span', null, `${m.path} → /mnt/dsh-shares/${m.name}`), h('button', { className: 'krun-btn', onClick: () => update(workspace, binding.mounts.filter((x) => x.name !== m.name)) }, '移除'))))),
        h('p', { className: 'krun-muted', role: 'status', 'aria-live': 'polite' }, message));
    }

    function VmPanel() {
      const [page, setPage] = React.useState('overview');
      const tabs = [['overview', '概览'], ['files', '虚拟机文件'], ['mounts', '目录、网络与绑定']];
      return h('div', { className: 'krun-panel' },
        h('header', { className: 'krun-panel-head' }, h('h1', null, '虚拟机管理'), h('p', { className: 'krun-muted' }, '查看运行状态并管理虚拟机资源。')),
        h('nav', { className: 'krun-tabs', 'aria-label': '虚拟机管理页面' }, tabs.map(([id, label]) => h('button', { key: id, className: `krun-btn${page === id ? ' krun-tab-active' : ''}`, 'aria-current': page === id ? 'page' : undefined, onClick: () => setPage(id) }, label))),
        page === 'overview' ? h(ManagementPage) : page === 'files' ? h(VmFiles) : h(VmMounts));
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
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'krun-vm', order: 20, label: '虚拟机管理' },
          ({ size, active }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': 'true' }, h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }), h('path', { d: 'M8 21h8m-4-4v4M7 9h3m4 0h3M7 13h2m4 0h4' }))
        ));
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'krun-vm' },
          VmPanel,
        ));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'krun-vm-status', order: 20 },
          StatusChip,
        ));
      },
    };
  },
});
