// 把分析结果写成给人看的文字（`npm run diagnose` 用）。
import { OBSERVER_LABELS, observedCounts, type RuntimeLogRecord, type RuntimeLogReport } from "@navi/shared/runtime-log";

const time = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });

/** 时间线上的一行：只挑分析时用得着的字段。 */
function line(record: RuntimeLogRecord): string {
  const skip = new Set(["at", "src", "ev", "pid", "frames", "stacks", "inflight"]);
  const fields = Object.entries(record)
    .filter(([key, value]) => !skip.has(key) && value !== undefined && typeof value !== "object")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `    ${clock(record.at)}  ${record.src.padEnd(6)} ${record.ev}${fields ? `  ${fields}` : ""}`;
}

export function renderRuntimeLogReport(report: RuntimeLogReport, options: { timeline?: boolean } = {}): string {
  const out: string[] = [];
  if (!report.from) return "没有运行日志。";
  out.push(`运行日志 ${time(report.from)} — ${time(report.to!)}`);
  out.push(`  记录：${Object.entries(report.counts).map(([src, n]) => `${src} ${n}`).join("、")}`);
  for (const note of report.notes) out.push(`  · ${note}`);
  out.push("");

  out.push(`窗口闪一下 / 重载：${observedCounts(report) || "没有"}`);
  for (const incident of report.incidents.slice(-30)) {
    out.push(`  ${time(incident.at)}  [${OBSERVER_LABELS[incident.seenBy]}] ${incident.summary}`);
    for (const evidence of incident.evidence) out.push(`      - ${evidence}`);
    if (options.timeline) for (const record of incident.timeline) out.push(line(record));
  }
  if (report.incidents.length > 30) out.push(`  （只列了最近 30 条，共 ${report.incidents.length} 条）`);
  out.push("");

  const s = report.stalls;
  out.push(`服务卡顿（≥1 秒）：${s.total} 次，其中 ≥1.5 秒 ${s.overOneAndHalf} 次，最长 ${(s.maxMs / 1000).toFixed(1)} 秒，中位 ${(s.medianMs / 1000).toFixed(1)} 秒`
    + (s.total ? `；在算 ${s.cpuBound} 次、在等 ${s.waiting} 次` : ""));
  if (report.hotspots.length) {
    out.push("  卡顿时最常在跑的代码：");
    for (const hot of report.hotspots) out.push(`    ${hot.frame}  —  ${hot.stalls} 次，约 ${(hot.ms / 1000).toFixed(1)} 秒`);
  }
  if (report.restarts.length) {
    out.push("", `服务重启：${report.restarts.length} 次`);
    for (const restart of report.restarts) out.push(`  ${time(restart.at)}  ${restart.how}`);
  }
  if (report.errors.length) {
    out.push("", "报错：");
    for (const error of report.errors) out.push(`  ${error.src.padEnd(6)} ${error.name} × ${error.count}（最近 ${time(error.last)}）`);
  }
  return out.join("\n");
}
