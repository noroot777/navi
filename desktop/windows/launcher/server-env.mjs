// 交给服务的环境（对应 mac 的 ServerLauncher.spawnDetached 那一段）。
//
// 从壳继承的环境出发（就是 explorer 给的那份，USERPROFILE、APPDATA 这些都对），改三样：
//   · PATH 换成注册表里此刻的那份，壳继承来的里面多出来的条目接在后面。用户装完 claude、codex 之后
//     explorer 传下来的 PATH 还是登录时的旧值，按它起的服务找不到新装的 `.cmd` 垫片。
//   · app 定下的几样写成明确的值：数据根、`NAVI_DESKTOP_APP=1`、`NAVI_LOCAL_ONLY`（放开别的设备访问时写 0
//     而不是不写，环境里旧名的 1 就顶不上来）、窗口专用端口；默认端口不传 PORT（服务的环境会一路继承给
//     agent 和应用内终端，多一个 PORT 会让里面起的前端 dev server 去抢 navi 的端口）。这几个服务读完就从
//     自己的环境里删掉，agent 拿不到。
//   · 清掉改名前的数据根变量（几代名字指向不同时服务拒绝起）和只给壳、控制器用的 NAVI_WIN_*。
// Windows 的环境变量名不分大小写：同一个名字换个大小写再放一份，子进程拿到哪一份说不准，所以按名字折叠后替换。
export function serverEnvironment(cfg, { inherited = process.env, registryPath = "", allowOtherDevices = false } = {}) {
  const env = {};
  const fold = (name) => (cfg.windows ? name.toUpperCase() : name);
  const set = (name, value) => {
    for (const key of Object.keys(env)) if (fold(key) === fold(name)) delete env[key];
    if (value !== undefined) env[name] = value;
  };
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string") set(key, value);
  }
  for (const key of Object.keys(env)) {
    if (/^NAVI_WIN_/i.test(key) || /^(ASH|HARNESS)_DATA_DIR$/i.test(key)) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => fold(key) === fold("PATH")) ?? "PATH";
  set(cfg.windows ? "Path" : "PATH", mergePath(registryPath, env[pathKey] ?? "", cfg.windows));
  set("PORT", cfg.port === 4317 ? undefined : String(cfg.port));
  set("NAVI_DATA_DIR", cfg.dataDir);
  set("NAVI_DESKTOP_APP", "1");
  set("NAVI_LOCAL_ONLY", allowOtherDevices ? "0" : "1");
  set("NAVI_WINDOW_PORT", String(cfg.windowPort));
  return env;
}

/** 注册表那份在前；继承来的条目里没出现过的（不分大小写、去掉末尾的斜杠比）接在后面。 */
export function mergePath(registry, inherited, windows) {
  const separator = windows ? ";" : ":";
  const seen = new Set();
  const out = [];
  for (const entry of [...registry.split(separator), ...inherited.split(separator)]) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/[\\/]+$/, "");
    const folded = windows ? key.toLowerCase() : key;
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(trimmed);
  }
  return out.join(separator);
}
