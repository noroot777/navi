// 卡顿时到底在跑哪段代码。
//
// 事件循环被堵住的那几秒里，主线程自己什么都做不了 —— 卡完之后再 `new Error().stack` 拿到的是
// 定时器的栈，跟堵它的那段代码毫无关系。V8 的 CPU 采样器不一样：它在别的线程上按间隔打断主线程、
// 记下当时的 JS 调用栈，主线程卡在同步调用（execSync、readFileSync、大 JSON.parse）里时照样采得到。
//
// 一直开着采样有开销，所以**平时不开**：第一次看到够长的卡顿之后才武装，之后 30 分钟里每段约 15 秒
// 一个窗口滚动采；窗口里发生过卡顿，就把卡顿那段时间的样本按调用栈聚合，记一条 `loop.stall.stack`。
// 30 分钟里没再卡就撤掉。触发武装的那一次卡顿本身采不到（那时候还没开）—— 卡顿一般会反复出现，
// 采到的是后面几次。
//
// 记的只是核对过的代码位置（@navi/shared/runtime-log 的 verifyFrames，不存函数名），不是任何数据。
import { Session } from "node:inspector";
import { scrubFrame, verifyFrames } from "@navi/shared/runtime-log";
import { CODE_DIR } from "../paths.js";
import { serverCodeLocations } from "./code-symbols.js";
import { runtimeLog } from "./journal.js";

/** 卡顿超过这么久才武装采样器。 */
export const ARM_STALL_MS = 1500;
const ARMED_FOR_MS = 30 * 60_000;
const WINDOW_MS = 15_000;
/** 采样间隔（微秒）。10ms 一个样本：卡 2 秒就有约 200 个，够看清是谁，开销也小。 */
const SAMPLING_US = 10_000;

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type Profile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

export type StallWindow = { n: number; startPerf: number; endPerf: number; ms: number };

let session: Session | null = null;
let windowStartPerf = 0;
let armedUntil = 0;
let broken = false;
/** 正在收一段、开下一段：这期间的心跳不再动它。 */
let cycling = false;
let pending: StallWindow[] = [];

function post<T>(method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!session) return reject(new Error("no session"));
    session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result as T)));
  });
}

async function start(): Promise<void> {
  session = new Session();
  session.connect();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: SAMPLING_US });
  await post("Profiler.start");
  windowStartPerf = performance.now();
}

function stopSession(): void {
  try {
    session?.disconnect();
  } catch {
    /* 已经断了 */
  }
  session = null;
}

function giveUp(): void {
  broken = true;
  pending = [];
  stopSession();
}

/** 一次卡顿结束了（watch.ts 每次检测到都报）。够长就武装。 */
export function noteStall(stall: StallWindow): void {
  if (broken) return;
  if (session && stall.startPerf >= windowStartPerf) pending.push(stall);
  if (stall.ms < ARM_STALL_MS) return;
  armedUntil = performance.now() + ARMED_FOR_MS;
  if (!session) start().catch(giveUp);
}

/** 每个心跳调一次：窗口满了、或刚有卡顿结束，就收这一段、开下一段。 */
export function samplerTick(now: number): void {
  if (!session || broken || cycling) return;
  if (pending.length === 0 && now - windowStartPerf < WINDOW_MS) return;
  const stalls = pending;
  pending = [];
  cycling = true;
  const stopPerf = performance.now();
  post<{ profile: Profile }>("Profiler.stop")
    .then(async ({ profile }) => {
      for (const stall of stalls) summarize(profile, stopPerf, stall);
      if (performance.now() < armedUntil) {
        await post("Profiler.start");
        windowStartPerf = performance.now();
      } else {
        await post("Profiler.disable").catch(() => {});
        stopSession();
      }
    })
    .catch(giveUp)
    .finally(() => { cycling = false; });
}

const SPECIAL: Record<string, string> = {
  "(garbage collector)": "(gc)",
  "(program)": "(program)",
  "(idle)": "(idle)",
};

function summarize(profile: Profile, stopPerf: number, stall: StallWindow): void {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length === 0) return;
  const nodes = new Map<number, ProfileNode>();
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  // 采样器的时钟跟 performance.now() 不一定同一个起点：用「停下那一刻」对齐。
  const offsetUs = stopPerf * 1000 - profile.endTime;
  const fromUs = stall.startPerf * 1000 - offsetUs;
  const toUs = stall.endPerf * 1000 - offsetUs;
  const counts = new Map<string, { frames: string[]; count: number }>();
  // 同一个节点在几百个样本里反复出现：每个节点只核对一次出处。
  const verified = new Map<number, string>();
  let total = 0;
  let t = profile.startTime;
  for (let i = 0; i < samples.length; i += 1) {
    t += deltas[i] ?? 0;
    if (t < fromUs || t > toUs) continue;
    const frames = stackOf(samples[i]!, nodes, parent, verified);
    const key = frames.join("\n");
    const entry = counts.get(key) ?? { frames, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
    total += 1;
  }
  if (total === 0) return;
  const stacks = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((entry) => ({ pct: Math.round((entry.count / total) * 100), frames: entry.frames }));
  runtimeLog("loop.stall.stack", { n: stall.n, ms: Math.round(stall.ms), samples: total, stacks });
}

/** 叶子在前，最多 10 帧。 */
function stackOf(id: number, nodes: Map<number, ProfileNode>, parent: Map<number, number>, verified: Map<number, string>): string[] {
  const frames: string[] = [];
  let current: number | undefined = id;
  while (current !== undefined && frames.length < 10) {
    const node = nodes.get(current);
    if (!node) break;
    const { functionName, url, lineNumber } = node.callFrame;
    if (functionName === "(root)") break;
    const special = SPECIAL[functionName];
    if (special) return [special];
    let frame = verified.get(current);
    if (frame === undefined) {
      frame = verifyFrames([scrubFrame(functionName || "<anon>", url || undefined, url ? lineNumber + 1 : undefined, [CODE_DIR])], serverCodeLocations)[0]!;
      verified.set(current, frame);
    }
    frames.push(frame);
    current = parent.get(current);
  }
  return frames;
}
