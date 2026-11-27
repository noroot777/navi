// 主智能体正在生成的那一次工具调用（claude 流里 `content_block_start` 起、`input_json_delta` 一段段
// 接、`content_block_stop` 止），折成直播用的 `drafting` 事件（shared events.ts）。
//
// 为什么要有：模型写文件时，文件里每个字都是它当场输出的入参。一份上万字的文档要生成好几分钟，
// 这期间流里没有正文、没有工具行，页面看着就是停住了 —— qfix1xZNymhT 的用户以为它没在干活，
// 连着追问打断了四次，文档一次都没写完。
//
// 开头两秒不报（读个文件、跑条命令的入参一眨眼就生成完，不值得闪一下），之后每秒最多报一次。
import type { AgentEvent } from "@navi/shared";

const QUIET_MS = 2_000;
const EVERY_MS = 1_000;
// 入参里最先出来的通常就是路径：拿到它就能说「正在写哪个文件」。
const TARGET_RE = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;

type Drafting = { tool: string; json: string; since: number; shown: number };

export function claudeDrafting() {
  let drafting: Drafting | null = null;
  return {
    /** 读一条 `stream_event` 的 `event`；该报一次进度时返回那条事件。 */
    event(se: any, now = Date.now()): Extract<AgentEvent, { kind: "drafting" }> | null {
      if (se?.type === "message_start" || se?.type === "content_block_stop") {
        drafting = null;
        return null;
      }
      if (se?.type === "content_block_start") {
        const block = se.content_block;
        drafting = block?.type === "tool_use" && typeof block.name === "string"
          ? { tool: block.name, json: "", since: now, shown: 0 }
          : null;
        return null;
      }
      if (!drafting || se?.type !== "content_block_delta" || se.delta?.type !== "input_json_delta") return null;
      drafting.json += typeof se.delta.partial_json === "string" ? se.delta.partial_json : "";
      if (now - drafting.since < QUIET_MS || now - drafting.shown < EVERY_MS) return null;
      drafting.shown = now;
      const target = targetOf(drafting.json);
      return {
        kind: "drafting",
        tool: drafting.tool,
        ...(target ? { target } : {}),
        chars: drafting.json.length,
        since: new Date(drafting.since).toISOString(),
      };
    },
  };
}

function targetOf(json: string): string | null {
  const raw = TARGET_RE.exec(json)?.[1];
  if (!raw) return null;
  try {
    const path = JSON.parse(`"${raw}"`) as string;
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}
