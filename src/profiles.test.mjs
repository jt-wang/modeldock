import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  publishedSlugFor,
  profileById,
  profileOptions,
  applyCustomProfile,
  contextWindowDefault,
  AUTO_COMPACT_PERCENT,
} from "./profiles.mjs";

test("publishedSlugFor owner-qualifies every owned model", () => {
  const luna = OPENCODE_GO_PROFILE.availableModels.find((model) => model.id === "gpt-5.6-luna");
  assert.equal(luna.ownerQualified, true, "our Luna must stay out of the bare native gpt-5.6-luna slot");
  assert.equal(publishedSlugFor("opencode-go", luna), "gpt-5.6-luna@opencode-go");
  assert.equal(publishedSlugFor("opencode-go", "gpt-5.6-luna"), "gpt-5.6-luna@opencode-go", "string ids resolve through the profile entry too");
  assert.equal(publishedSlugFor("opencode-go", "deepseek-v4-flash"), "deepseek-v4-flash@opencode-go", "the default provider qualifies its own models too");
  assert.equal(
    publishedSlugFor("deepseek-official", "deepseek-v4-flash"),
    "deepseek-v4-flash@deepseek-official",
    "a duplicate in another provider is owner-qualified",
  );
  assert.equal(publishedSlugFor("opencode-go", "gpt-5.6-sol"), "gpt-5.6-sol", "an id no profile owns passes through untouched (native GPT)");
});

test("exposes every registered profile through the registry", () => {
  assert.equal(profileById("opencode-go"), OPENCODE_GO_PROFILE);
  assert.equal(profileById("deepseek-official"), DEEPSEEK_OFFICIAL_PROFILE);
  assert.equal(profileById("unknown-profile"), OPENCODE_GO_PROFILE, "unknown ids fall back to opencode-go");
});

test("lists all profiles as selectable options", () => {
  const options = profileOptions();
  assert.deepEqual(options.map((option) => option.id), ["opencode-go", "deepseek-official", "zai", "kimi", "custom"]);
  assert.ok(options.every((option) => typeof option.label === "string" && option.label.length > 0));
});

test("custom profile is empty until configured and fills from config", () => {
  const empty = applyCustomProfile({ customModel: "", customBaseUrl: "" });
  assert.equal(empty.availableModels.length, 0);
  const filled = applyCustomProfile({ customModel: "vendor/model-x", customBaseUrl: "https://vendor.example/v1", customVision: true });
  assert.equal(filled.id, "custom");
  assert.equal(filled.label, "Custom");
  assert.deepEqual(filled.availableModels, [
    { id: "vendor/model-x", label: "vendor/model-x", endpoint: "responses", supportsVision: true, ownerQualified: true, status: "available" },
  ]);
});

test("opencode-go profile keeps the Go-specific hardening flags", () => {
  assert.equal(OPENCODE_GO_PROFILE.blockedToolTypes.has("tool_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.blockedToolTypes.has("web_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.compactCompletedToolHistory, undefined, "legacy transform flags are gone");
  assert.equal(OPENCODE_GO_PROFILE.toolSearchAsFunction, undefined, "legacy transform flags are gone");
  assert.equal(OPENCODE_GO_PROFILE.harnessTools, undefined, "harness tool fields are gone");
});

test("deepseek-official profile routes the main model on DeepSeek with harness on the Go camp", () => {
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.blockedToolTypes.size, 0, "official API accepts every Codex local tool as type function");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.compactCompletedToolHistory, undefined, "legacy transform flags are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.stripSyntheticReasoningPlaceholder, undefined, "legacy transform flags are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessTools, undefined, "harness tool fields are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.baseUrl, "https://api.deepseek.com");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.tokenEnvName, "DEEPSEEK_API_KEY");
  assert.deepEqual(DEEPSEEK_OFFICIAL_PROFILE.availableModels.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.availableModels.every((model) => model.endpoint === "responses"), true);
});

test("model catalog is generated per profile with distinct comp hashes", () => {
  const instructions = "base";
  const goCatalog = OPENCODE_GO_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", baseInstructions: instructions });
  const officialCatalog = DEEPSEEK_OFFICIAL_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: instructions });
  assert.ok(goCatalog.models.length >= 1, "catalog includes the main model plus every available model");
  assert.equal(goCatalog.models[0].slug, "deepseek-v4-flash@opencode-go");
  assert.equal(goCatalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(goCatalog.models[0].supports_search_tool, false);
  assert.equal(goCatalog.models[0].default_reasoning_level, "high");
  // deepseek-v4-flash now carries DeepSeek's documented ladder rather than the
  // profile-level default.
  assert.deepEqual(goCatalog.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "max"]);
  assert.equal(officialCatalog.models[0].comp_hash, "modeldock-deepseek-official-v1");
  assert.equal(officialCatalog.models[0].supports_search_tool, false);
  assert.equal(officialCatalog.models[0].default_reasoning_level, "high", "DeepSeek documents high as the default effort");
  assert.deepEqual(
    officialCatalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["low", "high", "max"],
    "DeepSeek documents three rungs; none/minimal/medium/xhigh are aliases",
  );
  assert.notEqual(goCatalog.models[0].comp_hash, officialCatalog.models[0].comp_hash);
});

test("every profile compacts at 80% of the model context window", () => {
  // The default itself is exercised by the catalog test that sets
  // MODELDOCK_CONTEXT_WINDOW; here the point is that an explicit per-model
  // window drives the limit, not the default.
  for (const profile of [OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE]) {
    const catalog = profile.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: "base" });
    const model = catalog.models[0];
    assert.equal(model.context_window, 400_000, `${profile.id} declares deepseek-v4-flash at 400k`);
    assert.equal(model.max_context_window, 400_000);
    assert.equal(model.auto_compact_token_limit, Math.floor(400_000 * AUTO_COMPACT_PERCENT), `${profile.id} must auto-compact at 80% of the 400k window`);
  }
});


test("the MiMo family publishes no reasoning ladder, because the endpoint ignores it", () => {
  // Measured 2026-08-18 through the gateway against OpenCode Go. mimo-v2.5 and
  // mimo-v2.5-pro return 200 for every effort including `ultra` AND for the
  // bogus value "banana", and report no reasoning_tokens at any rung while
  // output tokens scatter with no trend (97/420/279/165...). deepseek-v4-flash
  // on the same provider 400s on "banana", so the endpoint validates when the
  // model actually supports the parameter - MiMo simply drops it.
  // mimo-v2.5-free was rate-limited (429) at measurement time; it is the free
  // tier of the same model on the same endpoint and is configured to match its
  // measured twins rather than left on a fallback ladder that was never real.
  const go = profileById("opencode-go");
  for (const id of ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.5-free"]) {
    const entry = go.availableModels.find((model) => model.id === id);
    assert.ok(entry, `${id} is published`);
    assert.equal(entry.reasoningEffortSupported, false, `${id} must not forward reasoning_effort`);
    assert.deepEqual(entry.reasoningEfforts, ["high"], `${id} publishes one cosmetic rung`);
  }
});
