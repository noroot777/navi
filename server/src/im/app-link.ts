// 卡片上「在 Navi 中打开」那条链接在这台机器上走不走得通。
//
// 链接本身是 `<卡片深链地址>/?project=&task=`（cards.ts taskLink），能不能打开取决于这份服务听在哪：
// 以本机自用模式起的（NAVI_LOCAL_ONLY，mac 版默认）只听 127.0.0.1，手机、别的电脑连端口都连不上，
// 地址填得再对也打不开 —— 设置页和保存时据此就地说一句（不拒存：开关一打开它就能用了）。
//
// mac 版只听本机时，另给桌面端飞书一条走本机回环的 http 地址（`http://127.0.0.1:<端口>/open-in-navi?...`），
// 放在按钮的 `pc_url` 上；手机端仍走 `default_url`。飞书桌面端点下去会把它当普通网页打开 —— 这台 Mac 上
// 的服务收到后自己替用户拉起 Navi.app 窗口、换到那个任务（open-in-navi.ts 跑 `open navi://...`）。
// 起先 pc_url 直接写 `navi://`：飞书文档只说 pc_url 支持 http 与 AppLink，第三方 scheme 在真飞书桌面端
// 点了没反应（用户实测 2026-11-21），所以 scheme 只在本机这一跳上用，飞书只看见 http。
// 发卡的服务判断不了收卡的是哪台电脑、装没装 app，所以两条约束：
//   · 只在 http 在别的电脑上一律打不开时才给（app 起的服务、只听本机）：这时回环地址只可能让本机
//     那一台变好，别的电脑本来就打不开，不会更糟。放开了别的设备访问，`default_url` 每台电脑都打得开，
//     就不再给 —— 否则别的电脑点下去会撞到它们自己的 127.0.0.1。
//   · 链接自带来源：这份服务的指纹（instance-tag.ts）和原来那条 http 地址。收到的那份 Navi 比对指纹，
//     对上才打开那个任务；对不上（别的 Mac 发的卡、撞到了这台上另一份 Navi）就说清楚、给原地址，
//     不在别的工作台里打开一个同号的任务。
// 真飞书桌面端点回环 http 地址能不能打开没在本机以外验证过：回环地址的网页本身任何浏览器都打得开。
//
// 这条决定是起服务那一下定的（两个开关、指纹都是进程级常量），可卡片会被存下来、跨重启一直留在飞书上。
// 所以「会改变链接输出的一切」汇成一个 linkPolicy()：渲染出口（cards.ts openUrl）照它出链接，决策卡的
// 渲染指纹（reconcile.ts renderKeyOf）把它算进去，库里存着的所有卡在它变了之后按它重写（relink.ts）。
// 改了 desktopAppLink 的输出格式就把 LINK_FORMAT 加一，存着的旧格式卡才会被认出来、换掉。
import { isLoopbackHost } from "../auth/remote-access.js";
import { instanceTag } from "../instance-tag.js";
import { currentListeningPort } from "../listening-port.js";
import { DESKTOP_APP, LOCAL_ONLY } from "../local-only.js";

/** 深链地址在这台服务上为什么打不开（说给设置页看）；没问题是 null。 */
export function deepLinkWarning(base: string | null, env = { localOnly: LOCAL_ONLY, desktopApp: DESKTOP_APP }): string | null {
  if (!base) return null;
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return null;
  }
  if (isLoopbackHost(host)) return "这是本机地址，只有这台电脑打得开；手机上点卡片的按钮打不开。";
  if (!env.localOnly) return null;
  return env.desktopApp
    ? "这台 Navi 现在只允许本机访问，手机和别的电脑打不开这个地址。在 Navi.app 菜单「Navi › 允许其他设备访问」里打开之后就能用。"
    : "这份服务以本机自用模式（NAVI_LOCAL_ONLY）启动、只听 127.0.0.1，手机和别的电脑打不开这个地址。";
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const LINK_FORMAT = 3;
export const OPEN_IN_NAVI_PATH = "/open-in-navi";

/** 本机这份服务的回环地址（端口照实际监听的算）。 */
const loopbackOrigin = (): string => `http://127.0.0.1:${currentListeningPort() ?? 4317}`;

/** 链接策略的指纹：同一个值 = 同一条 http 地址渲染出的按钮一模一样。 */
export function linkPolicy(
  env = { localOnly: LOCAL_ONLY, desktopApp: DESKTOP_APP }, tag: () => string = instanceTag, origin: () => string = loopbackOrigin,
): string {
  return env.desktopApp && env.localOnly ? `${LINK_FORMAT}:local:${origin()}:${tag()}` : `${LINK_FORMAT}:http`;
}

/** 桌面端飞书用的那条回环地址；不该给（见文件头）、或者链接不是任务链接时是 null。 */
export function desktopAppLink(
  url: string,
  env = { localOnly: LOCAL_ONLY, desktopApp: DESKTOP_APP },
  tag: () => string = instanceTag,
  origin: () => string = loopbackOrigin,
): string | null {
  if (!env.desktopApp || !env.localOnly) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const out = new URLSearchParams();
  for (const key of ["project", "task"]) {
    const value = parsed.searchParams.get(key);
    if (value === null) continue;
    if (!ID_RE.test(value)) return null;
    out.set(key, value);
  }
  if (!out.has("project")) return null;
  out.set("instance", tag());
  out.set("fallback", url);
  return `${origin()}${OPEN_IN_NAVI_PATH}?${out}`;
}

/** 只认 id 字形的 project / task（navi:// 和 /open-in-navi 两头同一个判据）；不是任务链接是 null。 */
export function taskIdsOf(params: URLSearchParams): { project: string; task: string | null } | null {
  const project = params.get("project");
  const task = params.get("task");
  if (!project || !ID_RE.test(project) || (task !== null && !ID_RE.test(task))) return null;
  return { project, task };
}
