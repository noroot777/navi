// 服务进程自己的运行状况：事件循环卡顿、电脑睡眠、长 GC、定时的体征。
//
// 为什么最要紧的是卡顿：mac 窗口每秒探一次 /api/health（1.5 秒超时），连着三次答不上就当服务没了，
// 撤掉页面重新认人 —— 用户看到的就是「闪一下重启」，而服务其实一直活着，只是主线程被什么同步活儿
// 堵了几秒。所以这里每 250ms 打一次心跳，两次之间隔得太久就记一条 `loop.stall`，带上：
//   · `cpuMs`  这段时间进程实际用了多少 CPU。≈ 卡顿时长 = 在跑 JS / 同步计算；远小于 = 在等同步调用
//              （execSync、spawnSync、同步读大文件）或者被系统压着没调度；
//   · `gcMs`   这段时间里垃圾回收占了多少；
//   · `inflight` 那一刻在处理的请求（路由模板）；
//   · 够长的卡顿还会武装 sampler.ts，后面几次卡顿带上调用栈。
//
// 电脑睡眠也会让两次心跳隔很久，但那不是卡顿：单调时钟在睡眠时不走、墙上时钟照走，两者差出来的就是
// 睡了多久，记成 `system.sleep`。
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { requestsDuring, takeServedCount } from "./http.js";
import { runtimeLog } from "./journal.js";
import { noteStall, samplerTick } from "./sampler.js";

const TICK_MS = 250;
/** 两次心跳之间多出来这么久才算卡顿。窗口的探活超时是 1.5 秒，1 秒起记能看到「差一点就撤页」的那些。 */
const STALL_MS = 1000;
const SLEEP_MS = 2000;
const VITALS_MS = 10 * 60_000;
const LONG_GC_MS = 300;

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / MB);

type Gc = { start: number; end: number; kind: number };
const recentGc: Gc[] = [];

let started = false;
let stallSeq = 0;

function gcWithin(from: number, to: number): number {
  let total = 0;
  for (const gc of recentGc) {
    const overlap = Math.min(gc.end, to) - Math.max(gc.start, from);
    if (overlap > 0) total += overlap;
  }
  return Math.round(total);
}

function watchGc(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0;
        recentGc.push({ start: entry.startTime, end: entry.startTime + entry.duration, kind });
        if (entry.duration >= LONG_GC_MS) {
          runtimeLog("gc.long", { ms: Math.round(entry.duration), kind, heapMB: mb(process.memoryUsage().heapUsed) });
        }
      }
      if (recentGc.length > 200) recentGc.splice(0, recentGc.length - 200);
    });
    observer.observe({ entryTypes: ["gc"] });
  } catch {
    /* 拿不到 GC 事件就不报 gcMs 之外的东西 */
  }
}

function watchLoop(): void {
  let lastMono = performance.now();
  let lastWall = Date.now();
  let lastCpu = process.cpuUsage();
  const timer = setInterval(() => {
    const mono = performance.now();
    const wall = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const monoGap = mono - lastMono;
    const wallGap = wall - lastWall;
    lastMono = mono;
    lastWall = wall;
    lastCpu = process.cpuUsage();
    const slept = wallGap - monoGap;
    if (slept >= SLEEP_MS) {
      runtimeLog("system.sleep", { ms: Math.round(slept), from: new Date(wall - wallGap).toISOString() });
    } else {
      const blocked = monoGap - TICK_MS;
      if (blocked >= STALL_MS) {
        const n = ++stallSeq;
        const memory = process.memoryUsage();
        runtimeLog("loop.stall", {
          n,
          ms: Math.round(blocked),
          from: new Date(wall - blocked).toISOString(),
          cpuMs: Math.round((cpu.user + cpu.system) / 1000),
          gcMs: gcWithin(mono - monoGap, mono),
          rssMB: mb(memory.rss),
          heapMB: mb(memory.heapUsed),
          inflight: requestsDuring(mono - blocked, mono),
        });
        noteStall({ n, startPerf: mono - blocked, endPerf: mono, ms: blocked });
      }
    }
    samplerTick(mono);
  }, TICK_MS);
  timer.unref();
}

function watchVitals(): void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  const record = () => {
    const memory = process.memoryUsage();
    const heap = getHeapStatistics();
    const cpu = process.cpuUsage(lastCpu);
    const now = performance.now();
    const elapsed = Math.max(1, now - lastAt);
    lastCpu = process.cpuUsage();
    lastAt = now;
    const { served, inflight } = takeServedCount();
    runtimeLog("server.vitals", {
      rssMB: mb(memory.rss),
      heapMB: mb(memory.heapUsed),
      heapLimitMB: mb(heap.heap_size_limit),
      externalMB: mb(memory.external + memory.arrayBuffers),
      cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 100),
      loopP99Ms: Math.round(delay.percentile(99) / 1e6),
      loopMaxMs: Math.round(delay.max / 1e6),
      handles: process.getActiveResourcesInfo().length,
      served,
      inflight,
    });
    delay.reset();
    // 堆快顶到上限时多记一条：V8 OOM 之前留一个能看见的征兆。
    if (heap.used_heap_size > heap.heap_size_limit * 0.85) {
      runtimeLog("memory.high", { heapMB: mb(heap.used_heap_size), heapLimitMB: mb(heap.heap_size_limit) });
    }
  };
  setInterval(record, VITALS_MS).unref();
}

/** 服务起好之后调一次。 */
export function startRuntimeWatch(): void {
  if (started) return;
  started = true;
  watchGc();
  watchLoop();
  watchVitals();
}
