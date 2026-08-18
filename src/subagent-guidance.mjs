// Codex v2 spawn_agent is a local collaboration tool. The task argument is
// `message`. Isolated forks (fork_turns="none") deliver that message as an
// analysis-channel NEW_TASK. Native GPT-5 sees that channel; ModelDock text
// models do not, so a none-fork child replies standby even when message was
// filled. Measured 2026-08-19 on thread 01a00ee4: five none-forks with 900+
// char messages, children never received them; send_message then returned
// empty because the workers had already finished. Same-day GPT-5.6-sol
// fork_turns="all" children inherited user turns and worked.
//
// One string, used by the catalog and by image placeholders.

export const SUBAGENT_SPAWN_RULE =
  "Put the complete task in spawn_agent's `message` (not prompt). Omit fork_turns or use \"all\" so the child inherits this turn; fork_turns=\"none\" delivers NEW_TASK only on Codex's analysis channel, which these models cannot see, so the child replies standby. To give more work to an existing child, call followup_task — send_message only reaches a still-running worker and returns empty once it has finished.";

export function historicalImageSpawnHint(ref) {
  return `[Image attachment ${ref}. Its visual contents were handled in a prior turn. To re-inspect it, use vision_inspect with image_ref "${ref}", or spawn a vision subagent (agent_type="modeldock_subagent") with the complete question in spawn_agent's message. Omit fork_turns or use "all"; do not use fork_turns="none".]`;
}

const NEW_TASK_RE = /Message Type:\s*NEW_TASK\b[\s\S]*?Payload:\s*\n?([\s\S]+)/i;

export function newTaskPayloadFromText(text) {
  const match = String(text || "").match(NEW_TASK_RE);
  return match ? match[1].trim() : "";
}

function itemPlainText(item) {
  if (!item || typeof item !== "object") return "";
  const bits = [];
  const collect = (parts) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (typeof part?.text === "string") bits.push(part.text);
    }
  };
  collect(item.content);
  collect(item.summary);
  if (typeof item.text === "string") bits.push(item.text);
  return bits.join("\n");
}

function isPluginWrapperUser(item) {
  if (item?.type !== "message" || item?.role !== "user") return false;
  const text = itemPlainText(item);
  return text.includes("<recommended_plugins>") || text.includes("<app-context>");
}

export function promoteCollaborationNewTask(input) {
  if (!Array.isArray(input)) return input;
  let payload = "";
  for (const item of input) {
    const found = newTaskPayloadFromText(itemPlainText(item));
    if (found) payload = found;
  }
  if (!payload) return input;
  const already = input.some((item) => (
    item?.type === "message"
    && item?.role === "user"
    && !isPluginWrapperUser(item)
    && itemPlainText(item).includes(payload.slice(0, Math.min(80, payload.length)))
  ));
  if (already) return input;
  return [
    ...input,
    { type: "message", role: "user", content: [{ type: "input_text", text: payload }] },
  ];
}
