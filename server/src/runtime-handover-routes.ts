import type { Hono } from "hono";
import { DESKTOP_APP } from "./local-only.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { liveLockToken } from "./singleton.js";
import { isLocalDirect } from "./auth/remote-access.js";
import { secretsEqual } from "./openai-converter/common.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { heldTurns } from "./turn-lock.js";
import { commitRuntimeHandover, releaseRuntimeHandover, runtimeHandoverActive, runtimeHandoverDeadline, runtimeHandoverMatches } from "./runtime-handover-state.js";
import { resumeRuntimeGateway } from "./runtime-channel-gateway.js";
import { acquireForcedRuntimeHandover, acquireRuntimeHandover, type ForcedItem } from "./runtime-handover.js";
import { checkpointRuntimeHandover, sealRuntimeHandover } from "./runtime-handover-prepare.js";
import { runtimeCompatibility, type RuntimeCompatibility } from "./runtime-compatibility.js";

async function standingResources(): Promise<string[]> {
  const { shutdownResources } = await import("./shutdown-resources.js");
  return (await shutdownResources()).resources.map((resource) => resource.label || `${resource.kind} ${resource.id}`);
}

/** 同一批东西按强制切换名单的 id（kind:id）报，跟 Windows 控制器摆给用户的那张对得上。 */
async function standingItems(): Promise<ForcedItem[]> {
  const { shutdownResources } = await import("./shutdown-resources.js");
  return (await shutdownResources()).resources.map((resource) => ({
    id: `${resource.kind}:${resource.id}`, title: resource.label || `${resource.kind} ${resource.id}` }));
}

export function mountRuntimeHandoverRoutes(api: Hono) {
  api.post("/runtime-handover", async (context) => {
    const token = liveLockToken();
    if (!["darwin", "win32"].includes(process.platform) || !DESKTOP_APP || !isLocalDirect(context) || !token
      || !secretsEqual(requestHeader(context, NAVI_HEADERS.hostToken) ?? "", token)
      || requestHeader(context, NAVI_HEADERS.instance) !== INSTANCE_ID) {
      return context.json({ error: "没有接管这份服务的权限" }, 403);
    }
    type Body = Partial<RuntimeCompatibility> & { release?: string; check?: string; commit?: string; holdResources?: boolean; accept?: unknown };
    const body = await context.req.json<Body>().catch(() => ({} as Body));
    if (body.release) {
      const released = releaseRuntimeHandover(body.release);
      if (!runtimeHandoverActive()) {
        try { await resumeRuntimeGateway(); }
        catch (error) { return context.json({ released, error: `旧服务已解封，但通道恢复失败：${String(error)}` }, 503); }
      }
      return context.json({ released });
    }
    if (body.check) return context.json({ valid: runtimeHandoverMatches(body.check) });
    // 停服前最后一步：核验并兑现，兑现了这份服务就自己下线（见 commitRuntimeHandover）。
    if (body.commit) {
      return context.json({ committed: commitRuntimeHandover(body.commit, () => {
        console.warn("[navi] 接管许可已兑现，交给新版服务，退出");
        process.exit(0);
      }) });
    }
    const { restartImpact } = await import("./reattach.js");
    try {
      const current = runtimeCompatibility();
      // 带 accept（用户确认过会打断的那几项）就是强制切换：同样封口，封口之后核对名单（见 acquireForcedRuntimeHandover）。
      const result = Array.isArray(body.accept)
        ? await acquireForcedRuntimeHandover(() => restartImpact(body),
          new Set(body.accept.filter((id): id is string => typeof id === "string")), sealRuntimeHandover, standingItems)
        : await acquireRuntimeHandover(() => restartImpact(body), heldTurns, {
          seal: sealRuntimeHandover,
          async checkpoint(impact, lease) {
            await checkpointRuntimeHandover(impact, lease);
          },
        }, body.holdResources ? standingResources : undefined);
      const expiresAt = result.lease ? runtimeHandoverDeadline(result.lease) : null;
      return context.json({ ...result, protocol: current.protocol, ...(expiresAt ? { expiresAt } : {}) }, result.lease ? 200 : 409);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
}
