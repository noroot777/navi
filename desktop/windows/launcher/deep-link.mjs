// `navi://open?project=&task=&instance=&fallback=`：桌面端飞书卡片上「在 Navi 中打开」那条（对应 mac 的 DeepLink.swift，
// 规则一字不差；server/src/im/app-link.ts 只在 app 起的服务只听本机时把它放在按钮的 pc_url 上）。
//
// 发卡的那份 Navi 不一定是这个 app 连着的那份（另一台电脑发的卡、这台 app 指着别处），所以链接自带来源：
// `instance` 是发卡那份的指纹（server/src/instance-tag.ts），`fallback` 是原来那条 http 地址。自家服务报的指纹
// 对上才在窗口里打开那个任务；对不上、认不出就把 http 地址交给浏览器，不在这个工作台里打开一个同号的任务。
//
// 任何网页都能发起这种链接，所以它只能「导航」：只收 project / task 两个 id、一个指纹，fallback 只收指着
// 同一个任务的 http(s) 地址，别的一概不认 —— 认不出的链接只把窗口拉到前面。
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const TAG = /^[0-9A-F]{4}-[0-9A-F]{4}$/;

/** 认得出就返回 { route, instance, fallback }，认不出是 null。 */
export function parseLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "navi:" || url.host.toLowerCase() !== "open") return null;
  const value = (name) => url.searchParams.get(name);
  const query = new URLSearchParams();
  for (const key of ["project", "task"]) {
    const id = value(key);
    if (id === null) continue;
    if (!ID.test(id)) return null;
    query.append(key, id);
  }
  if (!query.has("project")) return null;
  const instance = value("instance");
  if (instance !== null && !TAG.test(instance)) return null;
  let fallback = null;
  const rawFallback = value("fallback");
  if (rawFallback !== null) {
    let target;
    try { target = new URL(rawFallback); } catch { return null; }
    if (!["http:", "https:"].includes(target.protocol) || !target.hostname) return null;
    for (const [key, id] of query) if (target.searchParams.get(key) !== id) return null;
    fallback = target.href;
  }
  return { route: `/?${query}`, instance, fallback };
}

/** servedTag：自家服务报的指纹；没认出自家服务（没起来、被占着、app 指着别处的 navi）时是 null。 */
export function decideLink(link, servedTag) {
  if (servedTag && (link.instance === null || link.instance === servedTag)) return { kind: "window", route: link.route };
  return link.fallback ? { kind: "browser", url: link.fallback } : { kind: "front" };
}
