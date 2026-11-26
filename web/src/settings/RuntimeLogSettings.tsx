// 「运行日志」设置节：最近几天窗口闪过几次、各是什么原因、服务重启过几次，以及把日志导出成一个文件发给别人分析。
// 记什么、不记什么见 @navi/shared/runtime-log 顶部；分析口径见 server/src/runtime-log/analyze.ts。
import { useCallback, useEffect, useState } from "react";
import { OBSERVER_LABELS, observedCounts, type RuntimeLogReport } from "@navi/shared/runtime-log";
import { ApiError, apiPath, request } from "../lib/apiClient.ts";
import { localeDateTime } from "../lib/localeFormat.ts";
import { Button } from "../components/ui.tsx";
import "./runtime-log-settings.css";

const DAYS = 7;
/** 停在这一页时隔这么久重新取一次：新出的事要看得到，不必离开再进来。 */
const REFRESH_MS = 30_000;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

export function RuntimeLogSettings({ notify }: { notify: (message: string) => void }) {
  const [state, setState] = useState<{ dir: string; report: RuntimeLogReport } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => request<{ dir: string; report: RuntimeLogReport }>(`/runtime-log/report?days=${DAYS}`)
      .then((next) => { if (live) { setState(next); setFailed(null); } })
      .catch((error) => { if (live) setFailed(error instanceof ApiError ? error.message : "读不到运行日志"); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const doExport = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(apiPath("/runtime-log/export?days=14"));
      if (!response.ok) throw new Error(`导出失败（${response.status}）`);
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "navi-runtime-log.json";
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const report = state?.report;
  const incidents = report ? [...report.incidents].reverse().slice(0, 12) : [];
  // 窗口和页面各数各的（同一次可能两边都记了），分开说，不相加。
  const observed = report ? observedCounts(report) : "";
  const restarts = report ? [...report.restarts].reverse().slice(0, 8) : [];

  return (
    <section className="settings-section rtlog">
      <header className="settings-heading">
        <div>
          <h1>运行日志</h1>
          <p>服务卡顿、重启、窗口重载和报错的记录，不含任何任务内容。窗口无故闪一下时，原因在这里。</p>
        </div>
        <Button disabled={busy} onClick={() => void doExport()}>导出</Button>
      </header>

      {failed && <p className="settings-hint">{failed}</p>}
      {report && (
        <>
          <p className="rtlog-summary">
            最近 {DAYS} 天{observed ? `，${observed}` : "没有记录到窗口闪一下"}
            {report.restarts.length > 0 && <>。服务重启 {report.restarts.length} 次</>}
            {report.stalls.total > 0 && <>。服务卡顿 {report.stalls.total} 次，最长 {secs(report.stalls.maxMs)}</>}
          </p>
          {incidents.length > 0 && (
            <ol className="rtlog-incidents">
              {incidents.map((incident) => (
                <li key={`${incident.seenBy}:${incident.at}`}>
                  <time>{localeDateTime(incident.at)}</time>
                  <strong>{OBSERVER_LABELS[incident.seenBy]}：{incident.summary}</strong>
                  {incident.evidence.map((line) => <span key={line}>{line}</span>)}
                </li>
              ))}
            </ol>
          )}
          {restarts.length > 0 && (
            <ol className="rtlog-incidents">
              {restarts.map((restart) => (
                <li key={restart.at}>
                  <time>{localeDateTime(restart.at)}</time>
                  <strong>服务重启</strong>
                  <span>{restart.how}</span>
                </li>
              ))}
            </ol>
          )}
          {report.notes.map((note) => <p key={note} className="settings-hint">{note}</p>)}
          <p className="settings-hint rtlog-dir">{state.dir}</p>
        </>
      )}
    </section>
  );
}
