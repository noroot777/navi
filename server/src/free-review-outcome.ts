// 一轮审查结算成什么，和一条审查链此刻有没有落下最终结论 —— 同一套判据的两头：结算按前者落笔（free-workflow.ts），
// 想知道「这条链完了没有、完在哪」的地方（系统通知 system-notify-facts.ts）按后者从落了库的 run 行读回来。
//
// 落库时 repair 和 exhausted 都写成 stopped（还要修 / 修的次数用完了），区分它俩的只有轮数：结算那一笔按
// currentRound <= retryLimit 判转修复，而轮数上限只在 reviewing 时能改（free-review-rounds.ts），所以落定之后
// 同一行重算出来的一定是当时那个判断。finishedAt 不能拿来判：转修复的那一轮同样写了它，续审把 run 放回 reviewing
// 时也不清它（free-review-round.ts nextRound）。

export type FreeReviewOutcome = "failed" | "passed" | "repair" | "exhausted";

export function freeReviewOutcome(input: {
  turnOk: boolean;
  conclusion: string | null;
  currentRound: number;
  retryLimit: number;
}): FreeReviewOutcome {
  if (!input.turnOk || (input.conclusion !== "verified" && input.conclusion !== "verify_failed")) return "failed";
  if (input.conclusion === "verified") return "passed";
  return input.currentRound <= input.retryLimit ? "repair" : "exhausted";
}

/**
 * 这条链的最终结论：通过 / 没给出结论（审查自己挂了、起不来）/ 修的次数用完还没过。null = 还没完：在审、转了修复
 * 等续审。同一条链可以在用完之后再续（手动修复、再审一轮），所以一次结论认「哪条链 + 第几轮 + 落成什么」。
 */
export function reviewChainVerdict(run: { id: string; status: string; currentRound: number; retryLimit: number }):
  { verdict: "passed" | "failed" | "exhausted"; identity: string } | null {
  const verdict = run.status === "passed" ? "passed"
    : run.status === "failed" ? "failed"
    : run.status === "stopped" && run.currentRound > run.retryLimit ? "exhausted"
    : null;
  return verdict ? { verdict, identity: `${run.id}:${run.currentRound}:${verdict}` } : null;
}
