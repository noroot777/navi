// 系统通知在客户端合成（src/lib/noticeBatch.ts）：几条以内各弹各的，超过上限合成一条、不带任务；合成的只用收到的那几条
// （每一条都已经按收件人过过滤，见 server/src/auth/event-filter.ts）。
import assert from "node:assert/strict";
import { batchNotices, DIGEST_OVER } from "../src/lib/noticeBatch.ts";

const notice = (n) => ({
  type: "task.notify", taskId: `t${n}`, projectId: "p1", ownerUserId: null, kind: "accept",
  key: `t${n}:accept:done#1`, title: `任务 ${n}`, subtitle: "项目", body: "完成了，等你验收",
});

const few = batchNotices([1, 2].map(notice));
assert.deepEqual(few.map((item) => [item.taskId, item.projectId, item.body]), [["t1", "p1", "完成了，等你验收"], ["t2", "p1", "完成了，等你验收"]],
  "上限以内：各弹各的，带着任务");
assert.equal(batchNotices(Array.from({ length: DIGEST_OVER }, (_, i) => notice(i))).length, DIGEST_OVER, "正好上限：不合");

const many = batchNotices(Array.from({ length: DIGEST_OVER + 1 }, (_, i) => notice(i)));
assert.equal(many.length, 1, "超过上限：合成一条");
assert.equal(many[0].taskId, null);
assert.equal(many[0].projectId, null);
assert.equal(many[0].title, `${DIGEST_OVER + 1} 件事等你看`);
assert.equal(many[0].body, `「任务 0」、「任务 1」、「任务 2」 等 ${DIGEST_OVER + 1} 个任务`);
assert.equal(many[0].key, `digest:t0:accept:done#1:${DIGEST_OVER + 1}`);
assert.deepEqual(batchNotices([]), [], "什么都没有：不弹");

console.log("test-notice-batch: ok");
