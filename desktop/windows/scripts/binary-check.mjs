// 核对一份 Windows 运行时里的原生文件：每个 .exe/.dll/.node 都得是 x64 的 PE，任何地方都不能出现
// Mach-O / ELF（在 mac 上装依赖时最容易混进来的就是 darwin 的预编译包）。只看文件头，不靠扩展名猜：
// 扩展名对不上的二进制同样会被认出来。
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PE_MACHINES = { 0x8664: "x64", 0x14c: "x86", 0xaa64: "arm64" };
const NATIVE_EXTENSIONS = /\.(?:exe|dll|node)$/i;

function head(file, length) {
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(file, "r");
  try { return buffer.subarray(0, readSync(descriptor, buffer, 0, length, 0)); }
  finally { closeSync(descriptor); }
}

/** 认出一个文件是什么二进制：{ kind: "pe", machine } / { kind: "mach-o" } / { kind: "elf" } / null（不是二进制）。 */
export function binaryKind(file) {
  const bytes = head(file, 4096);
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return { kind: "mach-o" };
    // fat Mach-O 有四种头（mach-o/fat.h：FAT_MAGIC / FAT_CIGAM / FAT_MAGIC_64 / FAT_CIGAM_64，CIGAM 是反字节序写的）。
    // 0xcafebabe 同时是 Java class 的魔数；fat 头紧跟的是架构个数（很小），class 是版本号（≥ 45）。
    if (magic === 0xcafebabe && bytes.length >= 8 && bytes.readUInt32BE(4) < 30) return { kind: "mach-o" };
    if (magic === 0xcafebabf && bytes.length >= 8 && bytes.readUInt32BE(4) < 30) return { kind: "mach-o" };
    if ([0xbebafeca, 0xbfbafeca].includes(magic) && bytes.length >= 8 && bytes.readUInt32LE(4) < 30) return { kind: "mach-o" };
    if (magic === 0x7f454c46) return { kind: "elf" };
  }
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const offset = bytes.readUInt32LE(0x3c);
    if (offset + 6 <= bytes.length && bytes.readUInt32BE(offset) === 0x50450000) {
      const machine = bytes.readUInt16LE(offset + 4);
      return { kind: "pe", machine: PE_MACHINES[machine] ?? `0x${machine.toString(16)}` };
    }
  }
  return null;
}

/** 扫整棵目录，返回违规清单（空 = 通过）和找到的 x64 原生文件。 */
export function scanWindowsBinaries(root) {
  const problems = [];
  const native = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) { problems.push(`${path}：是链接`); continue; }
      if (entry.isDirectory()) { walk(file, path); continue; }
      const kind = binaryKind(file);
      if (kind?.kind === "pe" && kind.machine === "x64") native.push(path);
      else if (kind) problems.push(`${path}：${kind.kind}${kind.machine ? ` ${kind.machine}` : ""}`);
      else if (NATIVE_EXTENSIONS.test(entry.name)) problems.push(`${path}：扩展名是原生文件，内容却不是 PE`);
    }
  };
  walk(root, "");
  return { problems, native };
}
