// 「为了重启而停服务」的那道冻结关口，客户端这一半（服务端在 server/src/restart-freeze.ts）。
//
// `npm run restart`（restart.mjs）和 Windows 壳的「允许其他设备访问」（desktop/windows/launcher/restart.mjs）
// 共用这一份；两边只是传输不同（一个走 node:http 直连本机，一个走 fetch），所以传输由调用方给：
// `send(body)` → `{ status, data, error }`（status 为 null = 没答上来；data 不论状态码都是解出来的正文）。
//
// 用法是三步：冻结拿快照 → 停服务之前续一次期（顺带核对冻结还在）→ 不停了就放掉。
// 停成了不用放：服务一退冻结就跟着没了；持有者自己崩了，冻结到期自己解。
// 续期的答复里带着**此刻**的名单：已经在跑的 agent 中途拉起 navi MCP 这种事服务端冻不住，调用方拿它跟
// 用户同意过的那份比，多出来就不停（各自的口径不同，比法留给调用方）。
//
// 老版本服务没有这道关口：`/restart-impact` 的答复里不带协议号（`supportsRestartFreeze` 为假），
// 调用方退回「即时评估」那条老路，并且如实说一句评估到停下之间的新任务不在名单里。

export const RESTART_FREEZE_PROTOCOL = 1;
export const RESTART_FREEZE_PATH = "/api/restart-freeze";

/** 这一份服务认不认这道关口：看 `/restart-impact` 答复里的协议号。 */
export function supportsRestartFreeze(impact) {
  return impact?.restartFreeze === RESTART_FREEZE_PROTOCOL;
}

const understood = (data) => data?.protocol === RESTART_FREEZE_PROTOCOL;
const reasonOf = (reply, fallback) => (typeof reply.data?.error === "string" && reply.data.error)
  || (reply.status === null ? `没有答复（${reply.error ?? "unknown"}）` : `${fallback}（服务端回 ${reply.status}）`);

/**
 * 冻结并拿快照：
 *  · `{ kind: "frozen", lease, instance, pid, revision, expiresInMs, impact }`
 *  · `{ kind: "busy", why }`     服务端认这道关口，但这会儿冻不了（另一处正在准备重启 / 正在换新版服务 / 没有权限）
 *  · `{ kind: "unknown", why }`  没答上来、答非所问
 */
export async function acquireRestartFreeze(send, { ttlMs } = {}) {
  const reply = await send(ttlMs === undefined ? {} : { ttlMs });
  const data = reply.data;
  if (reply.status === 200 && understood(data) && typeof data.lease === "string"
    && Array.isArray(data.impact?.interrupted) && Array.isArray(data.impact?.mcpDisrupted)) {
    return { kind: "frozen", lease: data.lease, instance: data.instance ?? null, pid: data.pid ?? null,
      revision: data.revision ?? null, expiresInMs: data.expiresInMs ?? null, impact: data.impact };
  }
  if (reply.status !== null && understood(data)) return { kind: "busy", why: reasonOf(reply, "冻结被拒") };
  return { kind: "unknown", why: reasonOf(reply, "冻结答复看不懂") };
}

/**
 * 停服务之前续一次期：`{ valid: true, expiresInMs, impact }`（impact 是此刻的名单，同冻结快照的形状），
 * 或者 `{ valid: false, why }`（到期了、被放掉了、问不到、此刻的名单没给出来）。
 */
export async function renewRestartFreeze(send, lease, { ttlMs } = {}) {
  const reply = await send(ttlMs === undefined ? { renew: lease } : { renew: lease, ttlMs });
  if (reply.status === 200 && understood(reply.data)) {
    if (reply.data.valid !== true) return { valid: false, why: "冻结已经失效（到期了，或者被放掉了）" };
    const impact = reply.data.impact;
    if (!Array.isArray(impact?.interrupted) || !Array.isArray(impact?.mcpDisrupted)) {
      return { valid: false, why: "续期答复里没有此刻的影响名单，核对不了" };
    }
    return { valid: true, expiresInMs: reply.data.expiresInMs ?? null, impact };
  }
  return { valid: false, why: reasonOf(reply, "续期答复看不懂") };
}

/** 不停了：放掉冻结。尽力而为 —— 放不掉也会到期自己解，所以只回放没放成。 */
export async function releaseRestartFreeze(send, lease) {
  try {
    const reply = await send({ release: lease });
    return reply.status === 200 && reply.data?.released === true;
  } catch {
    return false;
  }
}
