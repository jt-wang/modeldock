import test from "node:test";
import assert from "node:assert/strict";
import {
  parseModeldockToolName,
  parseUnsupportedModeldockOutput,
  healUnsupportedModeldockOutputs,
  payloadHasModeldockTools,
  relayUpstreamWithModeldockTools,
} from "./mcp-tool-relay.mjs";

test("parseModeldockToolName accepts flattened Codex names", () => {
  assert.equal(parseModeldockToolName("mcp__modeldock__vision_inspect"), "vision_inspect");
  assert.equal(parseModeldockToolName("namespace:mcp__modeldock__web_search_exa"), "web_search_exa");
  assert.equal(parseModeldockToolName("shell_command"), null);
});

test("parseUnsupportedModeldockOutput recognizes Codex unsupported call text", () => {
  assert.deepEqual(
    parseUnsupportedModeldockOutput("unsupported call: mcp__modeldock__vision_inspect"),
    { rawName: "mcp__modeldock__vision_inspect", tool: "vision_inspect" },
  );
  assert.equal(parseUnsupportedModeldockOutput("ok"), null);
});

test("healUnsupportedModeldockOutputs re-executes the paired function_call", async () => {
  const input = [
    {
      type: "function_call",
      call_id: "call_1",
      name: "mcp__modeldock__vision_inspect",
      arguments: JSON.stringify({ image_ref: "img_abc", question: "what color", mode: "ui" }),
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "unsupported call: mcp__modeldock__vision_inspect",
    },
  ];
  const upstreams = {
    inspectVision: async (args) => ({ answer: `seen ${args.image_ref}`, model: "mimo-v2.5" }),
  };
  const { input: healed, healed: count } = await healUnsupportedModeldockOutputs(input, upstreams);
  assert.equal(count, 1);
  const output = healed.find((item) => item.type === "function_call_output");
  assert.match(output.output, /seen img_abc/);
});

test("relayUpstreamWithModeldockTools loops until the model stops calling modeldock tools", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        id: "resp_1",
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call_v",
          name: "mcp__modeldock__vision_inspect",
          arguments: JSON.stringify({ path: "/tmp/x.png", question: "layout", mode: "ui" }),
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "resp_2",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The UI shows a dark sidebar." }],
      }],
      usage: { input_tokens: 20, output_tokens: 8 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await relayUpstreamWithModeldockTools({
      payload: {
        model: "deepseek-v4-flash",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "check screenshot" }] }],
        tools: [{ type: "function", name: "mcp__modeldock__vision_inspect", parameters: {} }],
      },
      upstreamModel: "deepseek-v4-flash",
      target: { url: "https://example.test/responses", token: "t" },
      upstreamHeaders: () => ({ Authorization: "Bearer t", "Content-Type": "application/json" }),
      upstreams: {
        inspectVision: async () => ({ answer: "dark sidebar", model: "mimo-v2.5" }),
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.fallbackToolResults, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].stream, false);
    const toolOutput = calls[1].input.find((item) => item.type === "function_call_output");
    assert.match(toolOutput.output, /dark sidebar/);
    assert.equal(result.response.output[0].content[0].text, "The UI shows a dark sidebar.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("payloadHasModeldockTools detects flattened tool declarations", () => {
  assert.equal(payloadHasModeldockTools([{ name: "mcp__modeldock__vision_inspect" }]), true);
  assert.equal(payloadHasModeldockTools([{ name: "shell_command" }]), false);
});
