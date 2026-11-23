import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appDigest, copyApp } from "../desktop/macos/scripts/release-artifacts.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS app copy and cross-volume DMG regression");
  process.exit(0);
}

const scripts = fileURLToPath(new URL("../desktop/macos/scripts/", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "navi-copy-app-"));
const mounted = new Set();
const source = join(temporary, "source with spaces", "Navi.app");
const binary = "Contents/MacOS/Navi";
const fallbackMessage = /\[mac-copy\] clone unavailable; retrying with ditto/;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}${result.stderr}`);
  return result;
}

function assertCopy(original, copied) {
  assert.equal(appDigest(copied), appDigest(original), "contents, relative links and executable bits survive copying");
  assert.equal(lstatSync(join(copied, binary)).mode & 0o777, 0o755);
  assert.equal(readlinkSync(join(copied, "Contents/MacOS/Navi-link")), "Navi");
  assert.equal(readlinkSync(join(copied, "Contents/Frameworks/Fixture.framework/Versions/Current")), "A");
  assert.equal(run("xattr", ["-p", "com.navi.copy-test", join(copied, binary)]).stdout.trim(), "preserved");
}

function withMounted(image, operation) {
  const mount = mkdtempSync(join(temporary, "mount-"));
  run("hdiutil", ["attach", image, "-nobrowse", "-noautoopen", "-mountpoint", mount]);
  mounted.add(mount);
  try {
    return operation(mount);
  } finally {
    run("hdiutil", ["detach", mount, "-force"]);
    mounted.delete(mount);
    rmSync(mount, { recursive: true, force: true });
  }
}

function crossVolume(filesystem) {
  const image = join(temporary, `${filesystem}.sparseimage`);
  run("hdiutil", ["create", "-quiet", "-size", "128m", "-fs", filesystem, "-type", "SPARSE", "-volname", "NaviCopyTest", image]);
  withMounted(image, (volume) => {
    assert.notEqual(statSync(volume).dev, statSync(source).dev, "fixture must really use another volume");
    const external = join(volume, "Navi.app");
    const result = run("bash", [join(scripts, "copy-app.sh"), source, external]);
    assert.match(result.stderr, fallbackMessage, "cross-volume copying exercises ditto fallback, not just the clone fast path");
    assertCopy(source, external);

    const restored = join(temporary, `${filesystem}-restored.app`);
    copyApp(external, restored);
    assertCopy(source, restored);
    writeFileSync(join(restored, binary), "modified destination");
    assertCopy(source, external);

    if (filesystem === "HFS+") {
      const sameVolume = join(volume, "second.app");
      run("bash", [join(scripts, "copy-app.sh"), external, sameVolume]);
      assertCopy(source, sameVolume);
    }

    const stage = join(temporary, `${filesystem}-staging`);
    mkdirSync(stage);
    assert.notEqual(statSync(stage).dev, statSync(external).dev);
    const dmg = join(temporary, `${filesystem}-release.dmg`);
    const packed = run("bash", [join(scripts, "make-dmg.sh"), external, dmg], { env: { ...process.env, TMPDIR: stage } });
    assert.match(packed.stderr, fallbackMessage, "DMG staging uses the same fallback across volumes");
    assert.match(packed.stdout, /\[mac-timing\] dmg\.stage-copy: \d+s status=0/);
    run("hdiutil", ["verify", dmg]);
    withMounted(dmg, (mount) => {
      assertCopy(source, join(mount, "Navi.app"));
      assert.equal(readlinkSync(join(mount, "Applications")), "/Applications");
      assert.deepEqual(readFileSync(join(mount, ".DS_Store")), readFileSync(join(scripts, "../dmg/DS_Store")));
    });
    console.log(`PASS: ${filesystem} cross-volume app snapshots and DMG staging preserve contents, modes, links and extended attributes`);
  });
}

try {
  mkdirSync(join(source, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(source, "Contents/Frameworks/Fixture.framework/Versions/A"), { recursive: true });
  writeFileSync(join(source, binary), "#!/bin/sh\nexit 0\n");
  chmodSync(join(source, binary), 0o755);
  writeFileSync(join(source, "Contents/Info.plist"), "fixture");
  writeFileSync(join(source, "Contents/Frameworks/Fixture.framework/Versions/A/Fixture"), "framework fixture");
  symlinkSync("Navi", join(source, "Contents/MacOS/Navi-link"));
  symlinkSync("A", join(source, "Contents/Frameworks/Fixture.framework/Versions/Current"));
  run("xattr", ["-w", "com.navi.copy-test", "preserved", join(source, binary)]);

  const local = join(temporary, "same-volume.app");
  copyApp(source, local);
  assertCopy(source, local);
  assert.throws(() => copyApp(source, local), /目标已存在，不覆盖/);
  assertCopy(source, local);
  const dangling = join(temporary, "existing-link.app");
  symlinkSync("missing", dangling);
  assert.throws(() => copyApp(source, dangling), /目标已存在，不覆盖/);
  assert.equal(readlinkSync(dangling), "missing");
  const missingTarget = join(temporary, "missing-target.app");
  assert.throws(() => copyApp(join(temporary, "missing.app"), missingTarget), /不是一个 .app/);
  assert.equal(existsSync(missingTarget), false);
  const blockedParent = join(temporary, "blocked-parent");
  writeFileSync(blockedParent, "do not change");
  assert.throws(() => copyApp(source, join(blockedParent, "Navi.app")), /复制 app 失败/);
  assert.equal(readFileSync(blockedParent, "utf8"), "do not change");
  console.log("PASS: same-volume copying preserves the app; existing targets and invalid paths are rejected without data loss");

  crossVolume("APFS");
  crossVolume("HFS+");
} finally {
  for (const mount of mounted) {
    const result = spawnSync("hdiutil", ["detach", mount, "-force"], { encoding: "utf8", timeout: 120_000 });
    if (result.status === 0) mounted.delete(mount);
    else console.error(`Unmount failed: ${mount}\n${result.stderr}`);
  }
  if (mounted.size === 0) rmSync(temporary, { recursive: true, force: true });
  else throw new Error(`Temporary volumes are still mounted under ${temporary}`);
}
