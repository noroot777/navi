// 服务启动的第一件事：拿这份库的单例锁。入口 index.ts 先加载本模块、再加载 main.ts，**顺序是这件事的全部**：
// db/index.ts 一加载就开库，而 main.ts 的静态依赖里有好几条路通到它（Monitor 中间件、预览代理、鉴权……），
// 等 main.ts 的正文去拿锁时库早就开过了。选库在拿锁之前，拿锁时 singleton.ts 在锁里重认一遍
// （跟库改名 rename-db 抢的是同一把），认准了才轮到任何人开库 —— 不然两步之间库被改了名，开的就是一份新建的空库。
import { acquireDbSingletonLock, SingletonConflictError, type SingletonLock } from "./singleton.js";
import { runtimeLog } from "./runtime-log/journal.js";

export const port = Number(process.env.PORT ?? 4317);

function acquire(): SingletonLock | null {
  try {
    return acquireDbSingletonLock({ port });
  } catch (e) {
    // 被挡回去的这一份也记一笔：「有人在服务活着的时候又起了一份」本身就是线索 —— mac 窗口
    // 探活连着失败、以为服务没了，就会这样再起一份（分析见 runtime-log/analyze.ts）。
    runtimeLog("server.refused", e instanceof SingletonConflictError ? { holderPid: e.holder.pid } : { reason: "lock_error" });
    if (e instanceof SingletonConflictError) console.error(e.message);
    else console.error("[navi] Refusing to start: failed to acquire the database singleton lock\n", e);
    process.exit(1);
  }
}

export const singletonLock = acquire();
