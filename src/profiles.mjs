
// What we tell Codex each relayed model can hold. This is a working figure for the
// upstreams we relay, not the headline number a vendor advertises for its own API:
// declaring 1M meant Codex never reached its own auto-compaction threshold and left
// the entire context problem to the gate. At 250k it manages the session itself and
// md_memory becomes a safety net rather than the only mechanism.
// Configurable so the figure can be corrected without a release.
// Read lazily, not once at import: config.mjs imports this module before it
// merges the .env file into process.env, so a module-level const captured the
// 250k default and the documented MODELDOCK_CONTEXT_WINDOW line in .env never
// reached the catalog - only a shell-exported value did.
function contextWindowDefault() {
  return Number(process.env.MODELDOCK_CONTEXT_WINDOW || 250_000);
}
const AUTO_COMPACT_PERCENT = 0.8;

export { contextWindowDefault, AUTO_COMPACT_PERCENT };

// The fixed model pair the Trial mode runs on. Both live in the opencode-go profile
// (zen free endpoint, same OpenCode token); Trial is a mode over that profile, not a
// new upstream, so these ids are the only thing Trial touches at runtime.
export const TRIAL_MAIN_MODEL = "deepseek-v4-flash-free";
export const TRIAL_VISION_MODEL = "mimo-v2.5-free";

// One description per effort, so a model's ladder is expressed as a list of
// effort names rather than a hand-written array per provider.
const REASONING_DESCRIPTIONS = {
  none: "No reasoning; direct responses only",
  minimal: "Barely any reasoning; fastest replies",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning for typical work",
  high: "Deeper reasoning for complex work",
  xhigh: "Extra-deep reasoning for hard problems",
  max: "Maximum reasoning depth",
};

// The ladder a model actually accepts. Which efforts an upstream honours is a
// property of the MODEL, not of the camp it is sold through - GLM-5.3 rejects
// xhigh while GLM-5.2 on the same endpoint takes all seven - so entries in
// availableModels may carry reasoningEfforts / defaultReasoningEffort and the
// profile-level values are only the fallback.
export function reasoningLadder(efforts) {
  return efforts
    .filter((effort) => REASONING_DESCRIPTIONS[effort])
    .map((effort) => ({ effort, description: REASONING_DESCRIPTIONS[effort] }));
}

const DEEPSEEK_REASONING_LEVELS = reasoningLadder(["low", "high", "max"]);

// Feature flags Codex reads from the model catalog to decide which client-side plugin
// machinery to expose (verified in the Codex binary's ModelInfo vocabulary):
// `artifact` = artifact-tool plugins (presentations / spreadsheets / documents / pdf),
// `tool_call_mcp_elicitation` = let the model request MCP tool schemas it does not have,
// `workspace_dependencies` = codex_app.load_workspace_dependencies,
// `computer_use` = desktop screen control, `browser_use` = Chrome control.
export const EXPERIMENTAL_SUPPORTED_TOOLS = ["artifact", "tool_call_mcp_elicitation", "workspace_dependencies", "computer_use", "browser_use"];

// One catalog entry. Codex's model picker lists whatever the active provider returns
// from /v1/models, so emitting an entry per available model is what makes them all
// selectable at runtime - no config rewrite, no restart.
function catalogEntry({ slug, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel, supportedReasoningLevels, priority, contextWindow = contextWindowDefault() }) {
  const autoCompactTokenLimit = Math.floor(contextWindow * AUTO_COMPACT_PERCENT);
  return {
        slug,
        display_name: displayName,
        description,
        prefer_websockets: false,
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        input_modalities: inputModalities,
        supports_image_detail_original: false,
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: false,
        tool_mode: null,
        multi_agent_version: "v2",
        use_responses_lite: false,
        include_skills_usage_instructions: false,
        auto_review_model_override: null,
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        auto_compact_token_limit: autoCompactTokenLimit,
        comp_hash: compHash,
        reasoning_summary_format: "experimental",
        default_reasoning_summary: "none",
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportedReasoningLevels,
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: "0.144.0",
        supported_in_api: true,
        availability_nux: null,
        upgrade: null,
        priority,
        experimental_supported_tools: EXPERIMENTAL_SUPPORTED_TOOLS,
        supports_search_tool: supportsSearchTool,
        default_service_tier: null,
        supports_reasoning_summaries: true,
        base_instructions: baseInstructions,
        model_messages: {
          instructions_template: baseInstructions,
          instructions_variables: {
            personality_default: "",
            personality_friendly: "",
            personality_pragmatic: "",
          },
        },
  };
}

function modelCatalogDefaults({ profileId, mainModel, displayName, description, compHash, inputModalities, supportsSearchTool, baseInstructions, defaultReasoningLevel = "high", supportedReasoningLevels = [ { effort: "low", description: "Fast responses with lighter reasoning" }, { effort: "high", description: "Deeper reasoning for complex work" }, { effort: "xhigh", description: "Extra-deep reasoning for hard problems" } ], availableModels = [] }) {
  // The main entry is owner-qualified like every other published entry, even when
  // the caller passed a bare reference (a legacy .env or a test fixture).
  const qualifiedMain = publishedSlugFor(profileId, mainModel);
  // Instructions are resolved per model: baseInstructions may be a function so a
  // model that can actually see is never handed the text-only vision paragraph.
  // A plain string still works for older callers and tests.
  const instructionsFor = typeof baseInstructions === "function"
    ? (supportsVision) => baseInstructions({ supportsVision: Boolean(supportsVision) })
    : () => baseInstructions;
  const visionOf = (id) => Boolean(
    (profileById(providerForModel({ profileId }, id)).availableModels || [])
      .find((entry) => entry.id === bareModelId(id))?.supportsVision,
  );
  const base = { compHash, supportsSearchTool };
  // Same per-model resolution as visionOf/contextWindowFor: look the entry up in
  // its OWNING provider so a main model from another camp keeps its own ladder.
  const entryFor = (id) => (profileById(providerForModel({ profileId }, id)).availableModels || [])
    .find((entry) => entry.id === bareModelId(id));
  // Fall back to the OWNING profile's ladder, not the active one: DeepSeek
  // Official ships a six-rung ladder defaulting to medium, and its models must
  // keep it when they appear inside another camp's catalog.
  const reasoningFor = (id, entry) => {
    const owner = profileById(providerForModel({ profileId }, id));
    return {
      defaultReasoningLevel: entry?.defaultReasoningEffort
        || owner?.defaultReasoningLevel
        || defaultReasoningLevel,
      supportedReasoningLevels: entry?.reasoningEfforts
        ? reasoningLadder(entry.reasoningEfforts)
        : (owner?.supportedReasoningLevels || supportedReasoningLevels),
    };
  };
  // The selected main model may belong to a provider other than the active
  // profile (e.g. a dashboard-added custom endpoint set as main). Label its
  // catalog entry "Provider - Model" like every other entry; the caller's
  // displayName stays the fallback for bare ids owned by the active profile.
  const ownerQualifiedDisplayName = (id) => {
    const at = String(id || "").lastIndexOf(PROVIDER_SEPARATOR);
    if (at <= 0) return null;
    const owner = String(id).slice(at + 1);
    const profile = profileById(owner);
    if (!profile?.label) return null;
    const modelLabel = (profile.availableModels || []).find((m) => m.id === bareModelId(id))?.label || bareModelId(id);
    return `${profile.label} - ${modelLabel}`;
  };
  // The main model may be the published slug (gpt-5.6-luna@opencode-go); the profile
  // catalog stores bare ids, so resolve through bareModelId before looking it up.
  // Resolve against the OWNING provider, not the active profile: the selected
  // main model routinely belongs to another camp now (a zai or kimi main under an
  // opencode-go profile). Searching only the local list missed and fell back to
  // the 250k default, under-declaring a 1M window by 4x and quartering the
  // auto-compact limit with it. Same lookup shape as visionOf above.
  const contextWindowFor = (id) => (
    (profileById(providerForModel({ profileId }, id)).availableModels || [])
      .find((model) => model.id === bareModelId(id))?.contextWindow
    || availableModels.find((model) => model.id === bareModelId(id))?.contextWindow
    || contextWindowDefault()
  );
  // Every provider's models in one list, each labelled with its source, so the picker
  // can switch upstream as well as model. The bare id stays with the default profile so
  // existing Codex configs keep resolving; another provider's copy of the same id is
  // published under an explicit owner suffix.
  const rest = [];
  for (const entry of profileOptions()) {
    const profile = profileById(entry.id);
    for (const model of profile.availableModels || []) {
      if (!model?.id || model.status === "unavailable") continue;
      const slug = publishedSlugFor(entry.id, model);
      if (slug === qualifiedMain || rest.some((m) => m.slug === slug)) continue;
      rest.push({
        slug,
        displayName: `${entry.label} - ${model.label || model.id}`,
        supportsVision: Boolean(model.supportsVision),
        providerLabel: entry.label,
        contextWindow: model.contextWindow || contextWindowDefault(),
      });
    }
  }
  return {
    models: [
      catalogEntry({ ...base, ...reasoningFor(qualifiedMain, entryFor(qualifiedMain)), baseInstructions: instructionsFor(visionOf(qualifiedMain)), slug: qualifiedMain, displayName: ownerQualifiedDisplayName(qualifiedMain) || displayName, description, inputModalities, priority: 1, contextWindow: contextWindowFor(qualifiedMain) }),
      ...rest.map((model, index) => catalogEntry({
        ...base,
        ...reasoningFor(model.slug, entryFor(model.slug)),
        baseInstructions: instructionsFor(model.supportsVision),
        slug: model.slug,
        displayName: model.displayName,
        description: `${model.providerLabel} through the local ModelDock gate.`,
        // Codex sends images only to models that declare the modality; the gate still
        // reroutes visual turns to the vision model for the text-only ones.
        inputModalities: model.supportsVision ? ["text", "image"] : ["text"],
        contextWindow: model.contextWindow,
        // 1 is the selected main model; the rest follow in provider order.
        priority: index + 2,
      })),
    ],
  };
}

const OPENCODE_GO_PROFILE = {
  id: "opencode-go",
  label: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  tokenEnvName: "OPENCODE_GO_TOKEN",

  blockedToolTypes: new Set(["tool_search", "web_search"]),
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", supportsVision: false, contextWindow: 400_000, status: "available" },
    // Zen free tier: same OpenCode token, but the upstream is zen/v1 not zen/go/v1.
    // deepseek-v4-flash-free is available but frequently returns 503 when the free
    // quota is exhausted; the upstream surfaces it per request.
    { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", zen: true, free: true, supportsVision: false, quota5h: 100000, status: "available" },
    { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, zen: true, free: true, supportsVision: false, status: "available" },
    { id: "laguna-s-2.1-free", label: "Laguna S 2.1 Free", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, zen: true, free: true, supportsVision: false, status: "available" },
    { id: "longcat-2.0-free", label: "Longcat 2.0 Free", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, zen: true, free: true, supportsVision: false, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", supportsVision: false, contextWindow: 400_000, status: "available" },
    { id: "glm-5", label: "GLM 5", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: false, status: "available" },
    { id: "glm-5.1", label: "GLM 5.1", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: false, status: "available" },
    { id: "glm-5.2", label: "GLM 5.2", endpoint: "responses", reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "max", supportsVision: false, status: "available" },
    // The bare id gpt-5.6-luna is also a native GPT picker slot, so our Luna is
    // published under the @opencode-go suffix and the bare id stays reserved for
    // the native backend's GPT-5.6-Luna.
    { id: "gpt-5.6-luna", label: "Luna", endpoint: "responses", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium", supportsVision: true, visionScore: 7, visionMaxScore: 9, visionTier: "medium", quota5h: 2050, speedTier: "fast", ownerQualified: true, status: "available" },
    { id: "grok-4.5", label: "Grok 4.5", endpoint: "responses", reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 120, speedTier: "fast", status: "available" },
    { id: "hy3", label: "Hy3", endpoint: "responses", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", supportsVision: false, status: "available" },
    { id: "hy3-preview", label: "Hy3 Preview", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "kimi-k2.5", label: "Kimi K2.5", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.6", label: "Kimi K2.6", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1150, speedTier: "fast", status: "available" },
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 1350, speedTier: "fast", status: "available" },
    { id: "kimi-k3", label: "Kimi K3", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "max", supportsVision: false, status: "available" },
    // imageUrlShape: measured 2026-08-17 against zen/go/v1/responses with the
    // same PNG - a bare-string image_url returns 400 `image_url is invalid`,
    // the chat-style { url } object returns 200. gpt-5.6-luna is the exact
    // opposite (string 200, object 400), so this cannot be a global choice.
    { id: "mimo-v2.5", label: "MiMo V2.5", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, imageUrlShape: "object", supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 30100, speedTier: "medium", status: "available" },
    { id: "mimo-v2.5-free", label: "MiMo V2.5 Free", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, zen: true, supportsVision: true, visionScore: 6, visionMaxScore: 9, visionTier: "medium", quota5h: 100000, speedTier: "fast", free: true, status: "available" },
    { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: false, status: "available" },
    { id: "mimo-v2-omni", label: "MiMo V2 Omni", endpoint: "responses", supportsVision: false, status: "unavailable" },
    { id: "mimo-v2-pro", label: "MiMo V2 Pro", endpoint: "responses", supportsVision: false, status: "unavailable" },
    // Chat-completions dialect is not supported by the passthrough gateway yet.
    // These models stay published-unavailable so the picker never offers a model
    // that would 400. Note several of them are vision-capable (minimax-m3, qwen3.5/
    // 3.6/3.7-plus, qwen3.8-max); they become candidates for the vision picker
    // once a chat adapter exists.
    { id: "minimax-m2.5", label: "MiniMax M2.5", endpoint: "chat", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: false, status: "unavailable" },
    { id: "minimax-m2.7", label: "MiniMax M2.7", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: false, status: "available" },
    { id: "minimax-m3", label: "MiniMax M3", endpoint: "chat", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 3200, speedTier: "fast", status: "unavailable" },
    { id: "qwen3.5-plus", label: "Qwen 3.5 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "medium", status: "unavailable" },
    { id: "qwen3.6-plus", label: "Qwen 3.6 Plus", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 3300, speedTier: "slow", status: "unavailable" },
    { id: "qwen3.7-max", label: "Qwen 3.7 Max", endpoint: "chat", supportsVision: false, status: "unavailable" },
    { id: "qwen3.7-plus", label: "Qwen 3.7 Plus", endpoint: "chat", supportsVision: true, visionScore: 8, visionMaxScore: 9, visionTier: "strong", quota5h: 4300, speedTier: "medium", status: "unavailable" },
    { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "unavailable" },
  ],

  modelCatalog({ mainModel, visionModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: OPENCODE_GO_PROFILE.id,
      mainModel,
      // The same "Provider - Model" label the rest of the catalog uses, so the
      // main entry does not render differently in the App picker.
      displayName: `${OPENCODE_GO_PROFILE.label} - ${OPENCODE_GO_PROFILE.availableModels.find((m) => m.id === bareModelId(mainModel))?.label || mainModel}`,
      description: "OpenCode Go through the local ModelDock Responses gate.",
      compHash: "modeldock-opencode-go-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      // Publish the whole curated catalog so every model is selectable from Codex's
      // own picker, not just the one the dashboard has selected.
      availableModels: OPENCODE_GO_PROFILE.availableModels,
    });
  },
};

const DEEPSEEK_OFFICIAL_PROFILE = {
  id: "deepseek-official",
  label: "DeepSeek Official",
  // Declared on the profile so the ladder travels with the models when another
  // camp's catalog lists them. DeepSeek documents three rungs (low/high/max)
  // defaulting to high; none/minimal/medium/xhigh are compatibility aliases on
  // the Responses wire that all collapse onto low or high, so publishing them
  // would add picker entries that change nothing.
  defaultReasoningLevel: "high",
  supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS,
  baseUrl: "https://api.deepseek.com",
  tokenEnvName: "DEEPSEEK_API_KEY",

  blockedToolTypes: new Set([]),
  // The official DeepSeek API accepts every Codex local tool as type "function", so
  // forward all except tools useless to a text-only model: view_image (native "vision"
  // helper) is hidden because the model cannot interpret images - vision_inspect is the
  // gateway's text-model path for visuals. Native web_search stays (provider supports it).
  hiddenToolNames: new Set(["view_image"]),
  // Verified live (2026-08-04) against the real Codex tool set: the official Responses
  // API accepts every Codex local tool as long as it is declared type "function"
  // (shell_command, update_plan, mcp resources, request_user_input, view_image) and
  // namespaces natively - only the "custom" tool type is restricted to apply_patch
  // ("Unsupported custom tool: 'shell_command'. Only 'apply_patch' is supported.").
  // Hosted web_search is native too (echoed in the response tools list); tool_search is
  // silently ignored. So the same allowlist as opencode-go works, and nothing is blocked.
  availableModels: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", supportsVision: false, contextWindow: 400_000, status: "available" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", supportsVision: false, contextWindow: 400_000, status: "available" },
  ],

  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: DEEPSEEK_OFFICIAL_PROFILE.id,
      mainModel,
      displayName: "DeepSeek V4 (Official)",
      description: "DeepSeek official Responses endpoint through ModelDock.",
      compHash: "modeldock-deepseek-official-v1",
      inputModalities: ["text"],
      supportsSearchTool: false,
      // Verified live (2026-08-04): the official API accepts reasoning effort in
      // { none, minimal, low, medium, high, xhigh, max } with thinking on by default
      // (effort null). The Go camp's low/high/max triple does not fit it.
      defaultReasoningLevel: "high",
      supportedReasoningLevels: DEEPSEEK_REASONING_LEVELS,
      availableModels: DEEPSEEK_OFFICIAL_PROFILE.availableModels,
      baseInstructions,
    });
  },
};

// Z.AI's coding plan. Speaks the Responses wire natively at /api/v1, so it needs
// no dialect translation - it is an ordinary profile like the two above.
// GLM-5.3 was measured (2026-08-17) against assets/vision/t1-red.png and
// t3-ocr.png: it accepted the input_image part but replied "I don't see an image
// in your message", so every model here is text-only and visual turns must keep
// escalating to a vision-capable model on another provider.
const ZAI_PROFILE = {
  id: "zai",
  label: "Z.AI GLM",
  baseUrl: "https://api.z.ai/api/v1",
  tokenEnvName: "ZAI_API_KEY",

  blockedToolTypes: new Set([]),
  hiddenToolNames: new Set(["view_image"]),
  availableModels: [
    { id: "glm-5.3", label: "GLM 5.3", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "max", supportsVision: false, contextWindow: 1_000_000, status: "available" },
    { id: "glm-5.2", label: "GLM 5.2", endpoint: "responses", reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "max", supportsVision: false, contextWindow: 1_000_000, status: "available" },
    { id: "glm-5-turbo", label: "GLM 5 Turbo", endpoint: "responses", reasoningEfforts: ["high"], defaultReasoningEffort: "high", reasoningEffortSupported: false, supportsVision: false, contextWindow: 200_000, status: "available" },
  ],

  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: ZAI_PROFILE.id,
      mainModel,
      displayName: "Z.AI GLM",
      description: "Z.AI coding plan through the local ModelDock gate.",
      compHash: "modeldock-zai-v1",
      inputModalities: ["text"],
      supportsSearchTool: false,
      baseInstructions,
      availableModels: ZAI_PROFILE.availableModels,
    });
  },
};

// Moonshot's Kimi coding plan. Also native Responses, at /coding/v1.
// k3 was measured (2026-08-17) on the same two fixtures and answered "Red" and
// "HELLO VISION 42" correctly, so it is genuinely vision-capable and must NOT be
// told it is text-only - see baseInstructionsFor's perModel handling.
const KIMI_PROFILE = {
  id: "kimi",
  label: "Kimi Code",
  baseUrl: "https://api.kimi.com/coding/v1",
  tokenEnvName: "KIMI_API_KEY",
  // Kimi's /coding/v1 Responses endpoint rejects tool_choice:"none" with 400
  // "Invalid request Error" even when tools is empty. tools:[] alone is enough
  // to keep the compact summarize call tool-free.
  supportsToolChoiceNone: false,
  // Kimi translates Responses history to chat messages and requires each
  // assistant.tool_calls row to be followed by role:"tool" messages. Codex
  // often stores the results only as top-level function_call_output items.
  materializeChatToolResults: true,

  blockedToolTypes: new Set([]),
  hiddenToolNames: new Set([]),
  availableModels: [
    { id: "k3", label: "Kimi K3", endpoint: "responses", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", contextWindow: 256_000, status: "available" },
  ],

  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: KIMI_PROFILE.id,
      mainModel,
      displayName: "Kimi Code",
      description: "Kimi coding plan through the local ModelDock gate.",
      compHash: "modeldock-kimi-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      availableModels: KIMI_PROFILE.availableModels,
    });
  },
};

// The user-configured endpoint profile (dashboard "Custom model" section). Empty
// until the Add flow writes MODELDOCK_CUSTOM_* into .env; applyCustomProfile()
// fills it at config load, so catalog building and per-model routing see the
// same model without any compile-time knowledge of the endpoint.
const CUSTOM_PROFILE = {
  id: "custom",
  label: "Custom",
  baseUrl: "",
  tokenEnvName: "MODELDOCK_CUSTOM_API_KEY",
  blockedToolTypes: new Set([]),
  hiddenToolNames: new Set([]),
  availableModels: [],
  modelCatalog({ mainModel, baseInstructions }) {
    return modelCatalogDefaults({
      profileId: CUSTOM_PROFILE.id,
      mainModel,
      displayName: "Custom endpoint",
      description: "User-configured custom Responses endpoint through ModelDock.",
      compHash: "modeldock-custom-v1",
      inputModalities: ["text", "image"],
      supportsSearchTool: false,
      baseInstructions,
      availableModels: CUSTOM_PROFILE.availableModels,
    });
  },
};

const PROFILES = {
  "opencode-go": OPENCODE_GO_PROFILE,
  "deepseek-official": DEEPSEEK_OFFICIAL_PROFILE,
  zai: ZAI_PROFILE,
  kimi: KIMI_PROFILE,
  custom: CUSTOM_PROFILE,
};

export function profileById(id) {
  return PROFILES[id] || OPENCODE_GO_PROFILE;
}

export function profileOptions() {
  return Object.values(PROFILES).map((profile) => ({ id: profile.id, label: profile.label }));
}

// Populate the custom profile from config so the catalog and per-model routing
// treat the configured endpoint/model like any other provider. Called at config
// load and after the dashboard Add flow writes new values.
export function applyCustomProfile(config) {
  const model = String(config.customModel || "").trim();
  const baseUrl = String(config.customBaseUrl || "").trim().replace(/\/+$/, "");
  CUSTOM_PROFILE.baseUrl = baseUrl;
  CUSTOM_PROFILE.availableModels = model && baseUrl
    ? [{
        id: model,
        label: model,
        endpoint: "responses",
        supportsVision: Boolean(config.customVision),
        // Always owner-qualified so the published slug carries @custom: the
        // picker groups it under "Custom" and routing never mistakes it for an
        // opencode-go model with the same bare id.
        ownerQualified: true,
        status: "available",
      }]
    : [];
  return CUSTOM_PROFILE;
}

// Resolve which provider owns a model id. The currently active profile wins, then any
// profile whose curated catalog lists the model. Used to route per-model upstream calls
// (main model on DeepSeek, vision on OpenCode Go) to the right base URL and token.
// A few ids (deepseek-v4-flash, deepseek-v4-pro) exist in more than one catalog, so the
// published slug carries its owner when the bare id would be ambiguous:
// "deepseek-v4-flash@deepseek-official". The suffix is a routing address only - it is
// stripped before the id reaches an upstream.
export const PROVIDER_SEPARATOR = "@";
// The profile whose ids are published bare, so ids already written into Codex configs
// keep resolving without a suffix.
const DEFAULT_PROFILE_ID = "opencode-go";

// The slug under which a model id is published in the Codex catalog. Every model a
// profile owns is published owner-qualified: the @provider suffix is a routing
// address that names the upstream, so the picker label, the catalog grouping, and
// the route can never disagree about which provider a model belongs to. A bare id
// survives only as a legacy reference (an older config.toml or a stored thread
// selection): it is never published and routes to the default provider (see
// providerForModel). Accepts either a profile model object or a bare id string, so
// the catalog builder and config loading share one rule.
export function publishedSlugFor(profileId, model) {
  const id = typeof model === "string" ? model : model?.id;
  if (!id) return model;
  const pid = profileId || DEFAULT_PROFILE_ID;
  const owned = profileById(pid).availableModels?.some((candidate) => candidate.id === id);
  return owned ? `${id}${PROVIDER_SEPARATOR}${pid}` : id;
}

export function bareModelId(model) {
  const at = String(model || "").lastIndexOf(PROVIDER_SEPARATOR);
  return at > 0 ? String(model).slice(0, at) : model;
}

export function providerForModel(config, model) {
  if (!model) return config?.profileId || "opencode-go";
  // An explicit owner in the slug outranks every heuristic below.
  const at = String(model).lastIndexOf(PROVIDER_SEPARATOR);
  if (at > 0) {
    const tagged = String(model).slice(at + 1);
    if (PROFILES[tagged]) return tagged;
  }
  // Bare id: legacy compatibility only. Bare ids were never published by any
  // provider other than the default one, so a bare id left over from an older
  // config or a stored thread selection routes there unconditionally instead of
  // to the currently active profile - the picker label and the billing source
  // must never disagree.
  return DEFAULT_PROFILE_ID;
}

// Resolve the curated model entry (label, endpoint, zen flag, vision metadata) for a
// bare model id. Used by the gateway to pick the upstream base URL per model.
export function modelEntryFor(config, model) {
  const provider = providerForModel(config, model);
  const bare = bareModelId(model);
  const owned = profileById(provider).availableModels?.find((entry) => entry.id === bare);
  if (owned) return owned;
  const passed = config?.profile;
  const current = passed?.availableModels
    ? passed
    : profileById(passed?.id || config?.profileId || "") || passed || null;
  return current?.availableModels?.find((entry) => entry.id === bare) || null;
}

export function tokenFor(config, model) {
  const provider = providerForModel(config, model);
  return config?.tokens?.[provider] || "";
}

export { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE, ZAI_PROFILE, KIMI_PROFILE };
