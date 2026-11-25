// 出 Windows 壳的图标 desktop/windows/shell/icons/icon.ico：docs/logo/icon.svg（米白圆角块上的 navi 标）画成几档 PNG，
// 原样装进一个 ICO（Vista 起 ICO 里直接放 PNG）。画图交给 docs/logo/rasterize.swift，所以只能在 macOS 上出；
// 出好的 .ico 进仓库，Windows 上原生构建直接用它。标改了就在 mac 上重跑：node desktop/windows/scripts/make-icon.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

export function packIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== "darwin") {
    console.error("图标要在 macOS 上出（rasterize.swift 用 AppKit 画 SVG）；Windows 上直接用仓库里的 icon.ico。");
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "navi-win-icon-"));
  try {
    const source = join(repo, "docs", "logo", "icon.svg");
    const jobs = SIZES.flatMap((size) => [source, join(scratch, `${size}.png`), String(size)]);
    execFileSync("swift", [join(repo, "docs", "logo", "rasterize.swift"), ...jobs], { stdio: "inherit" });
    const images = SIZES.map((size) => ({ size, png: readFileSync(join(scratch, `${size}.png`)) }));
    const target = join(repo, "desktop", "windows", "shell", "icons", "icon.ico");
    writeFileSync(target, packIco(images));
    console.log(`${target}（${SIZES.join("/")}）`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
