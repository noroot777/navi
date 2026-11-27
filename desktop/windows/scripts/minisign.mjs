// Tauri updater 的签名（minisign 格式，和 tauri-cli `signer sign` 出的一模一样），签和验都在这里：
// 发版脚本在把签名写进更新清单之前自己先验一遍 —— 云端 Secret 里的私钥要是和 release.json 的公钥不是一对，
// 发出去的每一台都装不上，这一步就拦在公开之前。
//
// 私钥和 mac 版共用一把 Ed25519 钥匙：Sparkle 导出的私钥（base64 的 32 字节种子，Secret MAC_SPARKLE_PRIVATE_KEY），
// 公钥是 desktop/macos/release.json 的 publicKey。minisign 只是在同一把钥匙外面多包一层：key id 由公钥推出
// （BLAKE2b-512 的前 8 字节），所以 release.json 里那份 minisign 公钥可以从 mac 的公钥重新算出来、对得上。
//
// 两段 base64 解开都是 minisign 的文本格式：
//   公钥  untrusted comment: …\n base64("Ed" + 8 字节 key id + 32 字节 Ed25519 公钥)
//   签名  untrusted comment: …\n base64("ED" + key id + 64 字节签名)\n trusted comment: …\n base64(64 字节全局签名)
// "ED" 是先对文件做 BLAKE2b-512 再签（tauri 只出这一种），"Ed" 是直接签文件；全局签名签的是「签名 + trusted comment」。
// tauri 的 trusted comment 里带着 version:<版本>，壳开了 requireSignedVersion，所以这里也核对它。
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const b64 = (value) => Buffer.from(value).toString("base64");
/** key id 按 minisign 自己显示的样子（小端、大写），和公钥文件第一行里的那串对得上。 */
const keyIdOf = (bytes) => Buffer.from(bytes).reverse().toString("hex").toUpperCase();

function lines(encoded, what) {
  const text = Buffer.from(String(encoded ?? "").trim(), "base64").toString("utf8");
  const rows = text.split(/\r?\n/);
  if (!rows[0]?.startsWith("untrusted comment:")) throw new Error(`${what}不是 minisign 格式`);
  return rows;
}

export function parsePublicKey(encoded) {
  const raw = Buffer.from(lines(encoded, "公钥")[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("公钥不是 minisign 的 Ed25519 公钥");
  return { keyId: keyIdOf(raw.subarray(2, 10)), key: createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]), format: "der", type: "spki" }) };
}

/** 验 file（Buffer）的签名；通过时返回 { keyId, trusted, version }，不通过抛错（说清哪一样不对）。 */
export function verifySignature(file, signature, publicKey, { version } = {}) {
  const rows = lines(signature, "签名");
  const raw = Buffer.from(rows[1] ?? "", "base64");
  if (raw.length !== 74) throw new Error("签名长度不对");
  const algorithm = raw.subarray(0, 2).toString();
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`不认识的签名算法 ${algorithm}`);
  const trusted = rows[2]?.startsWith("trusted comment: ") ? rows[2].slice("trusted comment: ".length) : null;
  const global = Buffer.from(rows[3] ?? "", "base64");
  if (trusted === null || global.length !== 64) throw new Error("签名里没有 trusted comment 或全局签名");
  const pub = parsePublicKey(publicKey);
  const keyId = keyIdOf(raw.subarray(2, 10));
  if (keyId !== pub.keyId) throw new Error(`签名用的私钥（key id ${keyId}）和公钥（${pub.keyId}）不是一对`);
  const message = algorithm === "ED" ? createHash("blake2b512").update(file).digest() : file;
  if (!verify(null, message, pub.key, raw.subarray(10))) throw new Error("签名和文件内容对不上");
  if (!verify(null, Buffer.concat([raw.subarray(10), Buffer.from(trusted, "utf8")]), pub.key, global)) throw new Error("trusted comment 被改过");
  const signed = /(?:^|\t)version:([^\t]+)/.exec(trusted)?.[1] ?? null;
  if (version !== undefined && signed !== version) throw new Error(`签名里绑的版本是 ${signed ?? "（没有）"}，不是 ${version}`);
  return { keyId, trusted, version: signed };
}

/** Ed25519 公钥（32 字节）的 key id：BLAKE2b-512 的前 8 字节，同一把钥匙永远是同一个 id。 */
const keyIdBytes = (raw) => createHash("blake2b512").update(raw).digest().subarray(0, 8);

/** 32 字节 Ed25519 公钥（或它的 base64，即 mac release.json 的写法）→ Tauri 写法的 minisign 公钥。 */
export function minisignPublicKey(ed25519) {
  const raw = Buffer.isBuffer(ed25519) ? ed25519 : Buffer.from(String(ed25519).trim(), "base64");
  if (raw.length !== 32) throw new Error("Ed25519 公钥应是 32 字节");
  const id = keyIdBytes(raw);
  return b64(`untrusted comment: minisign public key: ${keyIdOf(id)}\n${b64(Buffer.concat([Buffer.from("Ed"), id, raw]))}\n`);
}

/**
 * Sparkle 导出的私钥文本（generate_keys -x：base64 的 32 字节种子；64 字节的是种子 + 公钥）→ { privateKey, publicKey }。
 * 旧版 Sparkle 的 96 字节私钥是展开后的标量、推不回种子，node 签不了，直接拒。
 */
export function readSigningKey(text) {
  const raw = Buffer.from(String(text ?? "").trim(), "base64");
  if (raw.length !== 32 && raw.length !== 64) throw new Error(`私钥应是 base64 的 32 字节 Ed25519 种子（Sparkle generate_keys -x 导出的那种），这份是 ${raw.length} 字节`);
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(ED25519_SPKI.length);
  if (raw.length === 64 && !raw.subarray(32).equals(publicKey)) throw new Error("私钥后半段的公钥和种子推出来的对不上");
  return { privateKey, publicKey };
}

/** 按 tauri-cli `signer sign --app-version` 的样子签 file（路径）：BLAKE2b-512 预哈希，trusted comment 带版本。 */
export function signFile(file, version, keyText, { now = Date.now() } = {}) {
  const { privateKey, publicKey } = readSigningKey(keyText);
  const signature = sign(null, createHash("blake2b512").update(readFileSync(file)).digest(), privateKey);
  const trusted = `timestamp:${Math.floor(now / 1000)}\tfile:${basename(file)}\tversion:${version}`;
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), privateKey);
  const box = Buffer.concat([Buffer.from("ED"), keyIdBytes(publicKey), signature]);
  return b64(`untrusted comment: signature from tauri secret key\n${b64(box)}\ntrusted comment: ${trusted}\n${b64(global)}\n`);
}
