// persistent-shell 组内注册器：把 krun 终端后端挂进被 isolate 的 terminals 服务。
//
// 为什么存在：web-app preset 把 '@deepseek-ai/dsh-terminal'（terminals 服务）放在
// `persistent-shell`（cordis:group, isolate: { terminals: true }）组内激活——每组一个
// 独立实例，根作用域的 inject(['terminals']) 永远 pending。本模块经用户补丁层的
// "insert 到 group" 语法追加进该组 config（见 cordis.patch.yml），在组内注册。
//
// sandbox 服务未被 isolate，此处注入的是根作用域的 KrunSandboxProvider 实例，
// 终端会话经它 ensureSession 到 VM；注册 disposer 由本组 fiber 经 ctx.effect 接管，
// 组销毁时反注册（避免 DUPLICATE_BACKEND）。
import { KrunTerminalBackend } from './index.js';

export const name = 'krun-terminal-registrar';
export const inject = ['terminals', 'sandbox'];

export function apply(ctx) {
  const provider = ctx.sandbox;
  ctx.effect(() => ctx.terminals.registerBackend(new KrunTerminalBackend(provider)));
}
