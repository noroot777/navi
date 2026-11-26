// `npm run diagnose [-- <数据目录 | 导出包.json>] [--days 7] [--timeline] [--json]`
//
// 不给路径时看本机这份数据目录（NAVI_DATA_DIR，没设就是仓库里的 data/）。mac app 的数据在
// ~/Library/Application Support/dev.navi.mac；用户发来的导出包直接给文件路径。
// 只读文件，不连服务、不开库，服务在跑着也能看。
//
// 模块一律在算出默认目录**之后**才动态加载：load → paths.ts 加载时会把 NAVI_DATA_DIR 从环境里收走，
// 静态 import 会先于这里跑，默认目录就读成了仓库里的 data/（第 3 轮审查实测）。
export {};

const env = { ...process.env };
const { dataRootFor } = await import("../data-root.js");
const defaultDir = dataRootFor(env);
const { analyzeRuntimeLog } = await import("./analyze.js");
const { loadRuntimeLogPath } = await import("./load.js");
const { renderRuntimeLogReport } = await import("./render.js");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const path = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--days") ?? defaultDir;
const days = Number(option("--days") ?? 7);
const sinceMs = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : null;

try {
  const { records, exits, host } = loadRuntimeLogPath(path, sinceMs);
  const report = analyzeRuntimeLog(records, exits, sinceMs);
  if (flag("--json")) {
    console.log(JSON.stringify({ host, report }, null, 2));
  } else {
    console.log(`来源：${path}${host ? `（${host.platform} ${host.arch}，${host.cpus} 核，${host.memoryMB} MB，Node ${host.node}）` : ""}`);
    console.log(renderRuntimeLogReport(report, { timeline: flag("--timeline") }));
  }
} catch (error) {
  console.error(`读不了 ${path}：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
