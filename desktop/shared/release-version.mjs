// 版本号的口径，mac 与 Windows 两边的发版共用。

/** 给人看的版本号：三个非负整数（不带 v、不带前导零）。Tauri updater 按 semver 比，mac 的 Release/tag 也只带它。 */
export function assertVersion(version) {
  if (typeof version !== "string" || version.trim() !== version
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || !version.split(".").every((part) => Number.isSafeInteger(Number(part)))) {
    throw new Error("版本号要写成三个非负整数，例如 0.3.2（不带 v、不带前导零）");
  }
  return version;
}

/** 按点切段、逐段按数字比（Sparkle 的 SUStandardVersionComparator 口径；mac 的构建号「日期.时分秒」也这么比）。 */
export function compareVersions(a, b) {
  const parts = (v) => String(v).split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p < q ? -1 : 1;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}
