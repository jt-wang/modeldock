// Gateway-side execution for ModelDock MCP tools when Codex cannot run
// mcp__modeldock__* locally (returns "unsupported call: …"). The relay heals
// stale unsupported outputs in request history and runs proactive tool loops
// before Codex sees modeldock function_call items.

const MODELDOCK_PREFIXES = ["mcp__modeldock__", "namespace:mcp__modeldock__"];
const UNSUPPORTED_RE = /^unsupported call:\s*(.+)$/i;
const MAX_RELAY_ROUNDS = 8;

const TOOL_HANDLERS = {
  vision_inspect: "inspectVision",
  web_search_exa: "searchWeb",
  recall_memory: "recallMemory",
  store_memory: "storeMemory",
};

export function parseModeldockToolName(name) {
  if (typeof name !== "string") return null;
  for (const prefix of MODELDOCK_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return null;
}

export function parseUnsupportedModeldockOutput(output) {
  const text = typeof output === "string" ? output.trim() : "";
  const match = UNSUPPORTED_RE.exec(text);
  if (!match) return null;
  const tool = parseModeldockToolName(match[1].trim());
  return tool ? { rawName: match[1].trim(), tool } : null;
}

export function payloadHasModeldockTools(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => parseModeldockToolName(tool?.name));
}

export function formatToolOutput(result) {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export async function executeModeldockTool(toolName, args, upstreams) {
  const handlerKey = TOOL_HANDLERS[toolName];
  if (!handlerKey || !upstreams) throw new Error(`modeldock tool not available: ${toolName}`);
  const handler = upstreams[handlerKey];
  if (typeof handler !== "function") throw new Error(`modeldock tool not configured: ${toolName}`);
  return handler(args);
}

function functionCallsInOutput(output) {
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item?.type === "function_call" || item?.type === "custom_tool_call");
}

export function modeldockCallsInOutput(output) {
  return functionCallsInOutput(output).filter((item) => parseModeldockToolName(item.name));
}

export function outputHasOnlyModeldockCalls(output) {
  const calls = functionCallsInOutput(output);
  return calls.length > 0 && calls.every((item) => parseModeldockToolName(item.name));
}

export async function healUnsupportedModeldockOutputs(input, upstreams) {
  if (!Array.isArray(input) || !upstreams) return { input, healed: 0 };
  const callsById = new Map();
  for (const item of input) {
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const id = item.call_id ?? item.id;
      if (id) callsById.set(id, item);
    }
  }
  let healed = 0;
  const out = [];
  for (const item of input) {
    if (item?.type !== "function_call_output" && item?.type !== "custom_tool_call_output") {
      out.push(item);
      continue;
    }
    const unsupported = parseUnsupportedModeldockOutput(item.output);
    if (!unsupported) {
      out.push(item);
      continue;
    }
    const call = callsById.get(item.call_id);
    const toolName = call ? parseModeldockToolName(call.name) : unsupported.tool;
    if (!toolName || toolName !== unsupported.tool || !call) {
      out.push(item);
      continue;
    }
    try {
      const args = JSON.parse(call.arguments || "{}");
      const result = await executeModeldockTool(toolName, args, upstreams);
      out.push({ ...item, output: formatToolOutput(result) });
      healed += 1;
    } catch (error) {
      out.push({ ...item, output: `modeldock tool error: ${error.message}` });
      healed += 1;
    }
  }
  return { input: out, healed };
}

function mergeUsage(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  return {
    input_tokens: (base.input_tokens || 0) + (extra.input_tokens || 0),
    output_tokens: (base.output_tokens || 0) + (extra.output_tokens || 0),
    total_tokens: (base.total_tokens || 0) + (extra.total_tokens || 0),
    input_tokens_details: extra.input_tokens_details || base.input_tokens_details,
    output_tokens_details: extra.output_tokens_details || base.output_tokens_details,
  };
}

export async function relayUpstreamWithModeldockTools({
  payload,
  upstreamModel,
  target,
  upstreamHeaders,
  upstreams,
  signal,
  maxRounds = MAX_RELAY_ROUNDS,
}) {
  let workingInput = Array.isArray(payload.input) ? [...payload.input] : [];
  let lastResponse = null;
  let fallbackToolResults = 0;
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds += 1;
    const body = { ...payload, input: workingInput, stream: false, model: upstreamModel };
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders(target),
      body: JSON.stringify(body),
      signal,
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      return { ok: false, httpStatus: upstream.status, raw, fallbackToolResults, rounds };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, httpStatus: 502, raw, error: "Upstream returned invalid JSON", fallbackToolResults, rounds };
    }
    lastResponse = parsed;
    const modeldockCalls = modeldockCallsInOutput(parsed.output);
    if (!modeldockCalls.length) break;

    const allCalls = functionCallsInOutput(parsed.output);
    workingInput = [...workingInput, ...(parsed.output || [])];
    for (const call of modeldockCalls) {
      const toolName = parseModeldockToolName(call.name);
      try {
        const args = JSON.parse(call.arguments || "{}");
        const result = await executeModeldockTool(toolName, args, upstreams);
        workingInput.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: formatToolOutput(result),
        });
        fallbackToolResults += 1;
      } catch (error) {
        workingInput.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: `modeldock tool error: ${error.message}`,
        });
        fallbackToolResults += 1;
      }
    }

    if (allCalls.length > modeldockCalls.length) {
      const nonModeldock = (parsed.output || []).filter(
        (item) => !(item?.type === "function_call" && parseModeldockToolName(item.name)),
      );
      lastResponse = {
        ...parsed,
        output: nonModeldock,
        usage: mergeUsage(lastResponse?.usage, parsed.usage),
      };
      break;
    }
    lastResponse = { ...parsed, usage: mergeUsage(lastResponse?.usage, parsed.usage) };
  }

  return { ok: true, httpStatus: 200, response: lastResponse, fallbackToolResults, rounds };
}
