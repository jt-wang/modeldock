import assert from "node:assert/strict";
import test from "node:test";
import { promoteCollaborationNewTask, SUBAGENT_SPAWN_RULE } from "./subagent-guidance.mjs";

test("SUBAGENT_SPAWN_RULE names the real v2 args and forbids analysis-only none-forks", () => {
  assert.match(SUBAGENT_SPAWN_RULE, /spawn_agent's `message`/);
  assert.match(SUBAGENT_SPAWN_RULE, /followup_task/);
  assert.match(SUBAGENT_SPAWN_RULE, /omit fork_turns or use "all"/i);
  assert.doesNotMatch(SUBAGENT_SPAWN_RULE, /spawn_agent's prompt/);
});

test("promoteCollaborationNewTask copies analysis-channel NEW_TASK into a user message", () => {
  const payload = "撤销 A1：删掉注入的 TUI 目录。工作目录 /Users/me/projects/zcode-mobile。";
  const input = [
    {
      type: "reasoning",
      content: [{
        type: "reasoning_text",
        text: `Message Type: NEW_TASK\nTask name: /root/revert_zcode_system\nSender: /root\nPayload:\n${payload}`,
      }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<recommended_plugins>\nAirtable\n" }],
    },
  ];
  const out = promoteCollaborationNewTask(input);
  const users = out.filter((item) => item.type === "message" && item.role === "user");
  assert.equal(users.at(-1).content[0].text, payload, "the child model sees the spawn message as user text");
});

test("promoteCollaborationNewTask is a no-op when the user turn already has the task", () => {
  const payload = "verify bun install date; do not delete anything";
  const input = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: payload }],
    },
  ];
  assert.equal(promoteCollaborationNewTask(input), input);
});
