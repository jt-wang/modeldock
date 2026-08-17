import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { allowedEffortsFor, baseInstructionsFor, catalogFor, enabledProvidersFor, mergeNativeCatalog } from "./catalog.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";
import { isNativeModel } from "./gateway.mjs";

// A capture with no models merges nothing (mergeNativeCatalog returns early on
// an empty list) while still supplying captured_with. Fixed filename so repeated
// runs overwrite instead of littering the temp dir.
const MODERN_CODEX_CAPTURE = path.join(os.tmpdir(), "modeldock-test-native-modern.json");
writeFileSync(MODERN_CODEX_CAPTURE, JSON.stringify({ captured_with: "0.145.0", models: [] }), "utf8");

function configStub() {
  return {
    profile: OPENCODE_GO_PROFILE,
    profileId: "opencode-go",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "" },
    // Never read a real ~/.modeldock/native-catalog.json capture in tests. The
    // stub declares a current Codex and no models: the reasoning ladder is gated
    // on the captured client version, so without one every catalog would come
    // back on the pre-0.138 fallback ladder rather than its declared rungs.
    nativeCatalogFile: MODERN_CODEX_CAPTURE,
  };
}

test("catalogFor declares image input for the text-only main model (image escalation)", () => {
  const catalog = catalogFor(configStub());
  const main = catalog.models.find((entry) => entry.slug === "deepseek-v4-flash@opencode-go");
  assert.ok(main, "main model entry exists");
  assert.deepEqual(main.input_modalities, ["text", "image"], "endpoint handles images by escalating to the vision model");
  assert.equal(main.supports_search_tool, false, "search is the MCP tool, not a hosted schema");
  assert.equal(main.supports_parallel_tool_calls, false);
  assert.equal(main.reasoning_summary_format, "experimental");
});

test("catalogFor keeps the main model first with the profile comp hash", () => {
  const catalog = catalogFor(configStub());
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash@opencode-go");
  assert.equal(catalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(catalog.models[0].context_window, 400_000, "deepseek-v4-flash declares 400k so Codex compacts at 320k");
  assert.equal(catalog.models[0].auto_compact_token_limit, 320_000);
});

test("catalogFor covers every available model", () => {
  const catalog = catalogFor(configStub());
  const available = OPENCODE_GO_PROFILE.availableModels.filter((model) => model.status !== "unavailable").length;
  assert.ok(catalog.models.length >= available, `catalog lists at least the ${available} available models`);
  for (const entry of catalog.models) {
    assert.deepEqual(entry.input_modalities, ["text", "image"], `${entry.slug} declares image input at the endpoint`);
  }
});

test("MODELDOCK_CONTEXT_WINDOW from the env file still applies", () => {
  // The default was captured in a module-level const at import time, but .env is
  // only merged into process.env inside loadConfig(), which runs later - so the
  // documented .env knob (.env.example) never reached the catalog and only a
  // shell-exported value worked. Reading it lazily fixes that.
  const previous = process.env.MODELDOCK_CONTEXT_WINDOW;
  process.env.MODELDOCK_CONTEXT_WINDOW = "600000";
  try {
    const catalog = catalogFor(configStub());
    // glm-5 declares no contextWindow of its own, so it takes the default.
    const fallback = catalog.models.find((model) => model.slug === "glm-5@opencode-go");
    assert.ok(fallback, "a model without an explicit window is published");
    assert.equal(fallback.context_window, 600_000);
    assert.equal(fallback.auto_compact_token_limit, 480_000);
  } finally {
    if (previous === undefined) delete process.env.MODELDOCK_CONTEXT_WINDOW;
    else process.env.MODELDOCK_CONTEXT_WINDOW = previous;
  }
});

test("catalogFor declares each model's own reasoning ladder", () => {
  // The ladder is a property of the model, not of the camp it is sold through.
  // Sources: z.ai docs (GLM-5.3 takes only low/high/max, default max; GLM-5.2
  // takes the full seven) cross-checked against ZCode's own shipped config, and
  // direct measurement for k3 (low/medium/high/xhigh/max) and the OpenCode Go
  // models (all seven). Declaring xhigh for GLM-5.3 offers a value it rejects.
  const catalog = catalogFor({
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token", zai: "zai-token", kimi: "kimi-token" },
  });
  const efforts = (slug) => catalog.models
    .find((model) => model.slug === slug)
    ?.supported_reasoning_levels.map((level) => level.effort);
  const fallback = (slug) => catalog.models
    .find((model) => model.slug === slug)?.default_reasoning_level;

  assert.deepEqual(efforts("glm-5.3@zai"), ["low", "high", "max"]);
  assert.equal(fallback("glm-5.3@zai"), "max");
  assert.deepEqual(efforts("glm-5.2@zai"), ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  // k3 ACCEPTS medium and xhigh but Moonshot documents them as aliases of high,
  // so publishing them would add picker rungs that change nothing.
  assert.deepEqual(efforts("k3@kimi"), ["low", "high", "max"]);
  // DeepSeek documents three rungs with default high; none/minimal/medium/xhigh
  // are compatibility aliases on the Responses wire, and max - the real top
  // rung - was missing entirely.
  assert.deepEqual(efforts("deepseek-v4-flash@deepseek-official"), ["low", "high", "max"]);
  assert.equal(fallback("deepseek-v4-flash@deepseek-official"), "high");
  // Models with no effort mechanism at all publish a single cosmetic rung
  // rather than three fabricated ones.
  assert.deepEqual(efforts("kimi-k2.7-code@opencode-go"), ["high"]);
  assert.deepEqual(efforts("glm-5@opencode-go"), ["high"]);
  assert.deepEqual(efforts("grok-4.5@opencode-go"), ["low", "medium", "high"]);
  // MiMo joined that group on 2026-08-18: its endpoint returns 200 for `ultra`
  // and for the bogus effort "banana", so the four rungs published here were
  // never real. See the MiMo test in profiles.test.mjs for the measurement.
  assert.deepEqual(efforts("mimo-v2.5@opencode-go"), ["high"]);
  assert.deepEqual(efforts("hy3@opencode-go"), ["low", "high"]);

});

test("catalogFor declares the real window for a main model from another provider", () => {
  // contextWindowFor searched only the ACTIVE profile's availableModels, so a
  // main model owned by a different provider missed and silently fell back to
  // the 250k global - a 4x under-declaration for a 1M-window model, which also
  // quartered auto_compact_token_limit.
  const catalog = catalogFor({
    ...configStub(),
    mainModel: "glm-5.3@zai",
    tokens: { "opencode-go": "go-token", zai: "zai-token" },
  });
  const main = catalog.models.find((model) => model.slug === "glm-5.3@zai");
  assert.ok(main, "the cross-provider main model is published");
  assert.equal(main.context_window, 1_000_000);
  assert.equal(main.auto_compact_token_limit, 800_000);
});

test("catalogFor tells a vision-capable model it can see, not that it is text-only", () => {
  // The vision paragraph is written for DeepSeek, which genuinely cannot see. It
  // was being copied verbatim into EVERY entry, so a model with working vision
  // (measured: Kimi k3 reads a colour swatch and OCRs text correctly) was being
  // ordered to ignore its own eyes and round-trip through vision_inspect.
  const catalog = catalogFor({
    ...configStub(),
    tokens: { "opencode-go": "go-token", kimi: "kimi-token" },
  });
  const entry = (slug) => catalog.models.find((model) => model.slug === slug);

  const textOnly = entry("deepseek-v4-flash@opencode-go");
  assert.ok(textOnly, "the text-only model is published");
  assert.match(textOnly.base_instructions, /TEXT-ONLY model and CANNOT see images/);

  const visionCapable = entry("k3@kimi");
  assert.ok(visionCapable, "the vision-capable model is published");
  // A model that can see needs NO vision guidance at all - not a different
  // paragraph. Substituting one is still prompt injection; let the model and
  // Codex handle images the way they already do.
  assert.doesNotMatch(visionCapable.base_instructions, /TEXT-ONLY model and CANNOT see images/);
  assert.doesNotMatch(visionCapable.base_instructions, /Vision guidance/);
  assert.doesNotMatch(visionCapable.base_instructions, /vision_inspect with its local path/);
  // The rest of the harness guidance is unchanged.
  assert.match(visionCapable.base_instructions, /You are Codex, a coding agent/);
});

test("baseInstructionsFor includes the vision and restart guidance", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /TEXT-ONLY model and CANNOT see images/);
  assert.match(instructions, /call vision_inspect/);
  if (process.platform === "win32") {
    assert.match(instructions, /restart\.ps1/);
    assert.match(instructions, /powershell -ExecutionPolicy Bypass/);
  } else {
    assert.match(instructions, /restart\.sh/);
    assert.match(instructions, /sh "/);
  }
});

test("baseInstructionsFor includes the design-first workflow", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /Design-first workflow \(MANDATORY for frontend\/UI work\)/);
  assert.match(instructions, /run image_gen first/);
  assert.match(instructions, /read the output with vision_inspect/);
  assert.match(instructions, /implement by translating structure, palette, and hierarchy/);
});

test("baseInstructionsFor includes the memory lookup guidance", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /MEMORY\.md/);
  assert.match(instructions, /applies_to matches the current working directory/);
});

test("baseInstructionsFor pushes memory use when the vault is enabled", () => {
  const instructions = baseInstructionsFor({ ...configStub(), memoryEnabled: true });
  assert.match(instructions, /Memory \(MANDATORY\)/);
  assert.match(instructions, /call recall_memory once/);
  assert.match(instructions, /Call store_memory as soon as/);
});

test("baseInstructionsFor omits the memory push when the vault is disabled", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.doesNotMatch(instructions, /Memory \(MANDATORY\)/);
});

test("enabledProvidersFor includes the active profile and any provider with a token", () => {
  const ids = enabledProvidersFor(configStub());
  assert.deepEqual([...ids].sort(), ["opencode-go"]);

  const withDeepSeek = {
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
  };
  assert.deepEqual([...enabledProvidersFor(withDeepSeek)].sort(), ["deepseek-official", "opencode-go"]);
});

test("catalogFor publishes only models owned by enabled providers", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash@opencode-go"));
  assert.ok(!slugs.some((slug) => slug.endsWith("@deepseek-official")), "DeepSeek official models are hidden without a token");

  const withDeepSeek = {
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
  };
  const withDeepSeekCatalog = catalogFor(withDeepSeek);
  assert.ok(withDeepSeekCatalog.models.some((entry) => entry.slug === "deepseek-v4-flash@deepseek-official"));
});

test("the bare gpt-5.6-luna slot stays reserved for the native GPT pipeline", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("gpt-5.6-luna@opencode-go"), "our Luna is published under the owner suffix");
  assert.ok(!slugs.includes("gpt-5.6-luna"), "the bare id stays free for the native backend's GPT-5.6-Luna");
  const known = new Set(slugs);
  assert.equal(isNativeModel("gpt-5.6-luna", known), true, "a native request for the bare id passes through to ChatGPT");
  assert.equal(isNativeModel("gpt-5.6-luna@opencode-go", known), false, "our qualified slug stays on the routed path");
});

test("mergeNativeCatalog publishes picker-visible native models grouped with their provider", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 },
      { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "hide", priority: 23 },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    ],
  }), "utf8");
  try {
    const merged = mergeNativeCatalog(catalogFor(configStub()), { ...configStub(), nativeCatalogFile: file });
    const slugs = merged.models.map((entry) => entry.slug);
    const native = merged.models.find((entry) => entry.slug === "gpt-5.6-luna");
    assert.ok(native, "list-visible native model is published");
    assert.equal(native.display_name, "OpenAI - GPT-5.6-Luna", "native entries use the Provider - Model picker name");
    assert.equal(native.provider, "openai", "native entries are tagged for provider grouping");
    assert.ok(!slugs.includes("gpt-5.4-mini"), "picker-hidden native model stays out of the catalog");
    assert.ok(!slugs.includes("codex-auto-review"), "hidden native models stay out of the catalog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor with nativeMerge=false skips the native GPT merge for non-subscribers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-nomerge-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 }],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile: file, nativeMerge: false });
    const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash@opencode-go"), "curated Go models stay published");
    assert.ok(!slugs.includes("gpt-5.6-luna"), "native GPT models are hidden without a subscription (nativeMerge=false)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor in trial mode publishes only the fixed free pair and never merges native", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-trial-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 }],
  }), "utf8");
  try {
    const trial = catalogFor({
      ...configStub(),
      trialMode: true,
      mainModel: "deepseek-v4-flash-free",
      visionModel: "mimo-v2.5-free",
      nativeCatalogFile: file,
    });
    assert.deepEqual(trial.models.map((entry) => entry.slug).sort(), ["deepseek-v4-flash-free@opencode-go", "mimo-v2.5-free@opencode-go"]);
    assert.equal(trial.models[0].slug, "deepseek-v4-flash-free@opencode-go", "the fixed trial main model leads");
    assert.ok(!trial.models.some((entry) => entry.slug === "gpt-5.6-luna"), "trial never merges native GPT models");

    // The same native capture outside trial publishes the native model.
    const normal = catalogFor({ ...configStub(), nativeCatalogFile: file });
    assert.ok(normal.models.some((entry) => entry.slug === "gpt-5.6-luna"), "native model appears outside trial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor outside trial still publishes the free models alongside the paid ones", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash-free@opencode-go"));
  assert.ok(slugs.includes("mimo-v2.5-free@opencode-go"));
});

test("mergeNativeCatalog fills in the field older parsers require on every entry", () => {
  // Effort filtering moved to a single whole-catalog pass in catalogFor, because
  // it has to cover curated entries too. What is left here is the field that
  // pre-0.138 parsers demand on every model.
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.145.0",
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 1,
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "low", description: "Low" }, { effort: "high", description: "High" }],
    }],
  }), "utf8");
  try {
    const merged = mergeNativeCatalog(catalogFor(configStub()), { ...configStub(), nativeCatalogFile: file });
    const entry = merged.models.find((model) => model.slug === "gpt-5.6-sol");
    assert.ok(entry, "native entry is published");
    assert.equal(entry.supports_reasoning_summaries, true, "required field is defaulted for older CLI parsers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a current Codex keeps `max` and still loses `ultra`", () => {
  // Measured 2026-08-17 against chatgpt.com/backend-api/codex with gpt-5.6-sol:
  //   max   -> 200, and spends MORE reasoning than xhigh (39 vs 35 reasoning_tokens)
  //   ultra -> 400 "Invalid value: 'ultra'. Supported values are: 'none',
  //            'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'."
  // 0.138+ parse `ultra` happily, so nothing but this filter stops the 400.
  const catalog = catalogWithCodex("0.145.0");
  const entry = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
  assert.ok(entry, "native entry is published");
  assert.deepEqual(
    entry.supported_reasoning_levels.map((level) => level.effort),
    ["low", "high", "max"],
    "ultra is rejected upstream and dropped; max is accepted and kept",
  );
  assert.equal(entry.default_reasoning_level, "max", "an accepted default survives untouched");
});
test("catalogFor groups models by provider label with sequential priorities", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7 },
      { slug: "gpt-5.2", display_name: "GPT-5.2", visibility: "list", priority: 29 },
    ],
  }), "utf8");
  try {
    const catalog = catalogFor({
      ...configStub(),
      tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
      nativeCatalogFile: file,
    });
    const groups = [];
    for (const entry of catalog.models) {
      const label = entry.display_name.split(" - ")[0];
      if (groups.at(-1)?.label !== label) groups.push({ label, slugs: [] });
      groups.at(-1).slugs.push(entry.slug);
    }
    assert.deepEqual(groups.map((group) => group.label), ["DeepSeek Official", "OpenAI", "OpenCode Go"], "groups are ordered by provider label");
    assert.deepEqual(groups[1].slugs, ["gpt-5.5", "gpt-5.2"], "native entries keep their captured order within the group");
    assert.ok(groups[2].slugs[0].includes("deepseek-v4-flash") || groups[2].slugs[0] === "deepseek-v4-flash", "the curated main model opens the OpenCode Go group");
    catalog.models.forEach((entry, index) => {
      assert.equal(entry.priority, index + 1, `${entry.slug} carries a sequential picker priority`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a published native slug routes to the native leg despite being in the catalog", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" }],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile: file });
    const known = new Set(catalog.models.map((entry) => entry.slug));
    const nativeSlugs = new Set(["gpt-5.6-luna"]);
    assert.ok(known.has("gpt-5.6-luna"), "bare native slug is now published so the picker lists it");
    assert.equal(isNativeModel("gpt-5.6-luna", known, nativeSlugs), true, "native slug stays on the native leg");
    assert.equal(isNativeModel("gpt-5.6-luna@opencode-go", known, nativeSlugs), false, "our qualified Luna stays routed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor never publishes chat-dialect models even if marked available", () => {
  const profile = {
    ...OPENCODE_GO_PROFILE,
    availableModels: [
      ...OPENCODE_GO_PROFILE.availableModels.filter((m) => m.id !== "qwen3.8-max"),
      { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "available" },
    ],
  };
  const catalog = catalogFor({ ...configStub(), profile });
  assert.ok(!catalog.models.some((entry) => entry.slug === "qwen3.8-max"), "chat vision model must not be published");
});

// Codex builds before 0.138.0 parse reasoning_effort as a closed serde enum that
// stops at `xhigh`. Verified behaviourally 2026-08-18 by running 0.130.0, 0.137.0
// and 0.138.0 in a Linux container against real catalog files: a single `max`
// anywhere makes the old client exit 1 with
//   failed to parse model_catalog_json path `...`: unknown variant `max`,
//   expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
// and publish NO models at all - the failure is fatal, not a fallback. So the
// effort filter has to cover the whole file, curated entries included.
function catalogWithCodex(version, extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-gate-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    ...(version === null ? {} : { captured_with: version }),
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 1,
      default_reasoning_level: "max",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
        { effort: "ultra", description: "Ultra" },
      ],
    }],
  }), "utf8");
  try {
    return catalogFor({ ...configStub(), ...extra, nativeCatalogFile: file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const effortsIn = (catalog) => new Set(
  catalog.models.flatMap((m) => (m.supported_reasoning_levels || []).map((l) => l.effort)),
);

test("a pre-0.138 Codex gets no `max` anywhere, curated entries included", () => {
  const catalog = catalogWithCodex("0.130.0");
  const efforts = effortsIn(catalog);
  assert.ok(!efforts.has("max"), "one `max` anywhere aborts the whole parse on 0.130");
  assert.ok(!efforts.has("ultra"), "ultra is rejected by both the old client and the backend");
  assert.ok(efforts.has("xhigh") || efforts.has("high"), "the surviving ladder is not empty");
  const curated = catalog.models.filter((m) => m.minimal_client_version);
  assert.ok(curated.length > 0, "there are curated entries to check");
  assert.ok(
    curated.every((m) => !(m.supported_reasoning_levels || []).some((l) => l.effort === "max")),
    "curated entries are the ones that used to leak `max` past the native-only filter",
  );
});

test("0.137 is still gated and 0.138 is the first build that keeps `max`", () => {
  assert.ok(!effortsIn(catalogWithCodex("0.137.0")).has("max"), "0.137 rejects max");
  assert.ok(effortsIn(catalogWithCodex("0.138.0")).has("max"), "0.138 accepts max");
  assert.ok(effortsIn(catalogWithCodex("0.145.0")).has("max"), "later builds keep max");
});

test("an undetectable Codex version falls back to the safe ladder", () => {
  // Publishing `max` to a client we cannot identify risks an unparseable file
  // and zero models; withholding it only costs one rung.
  for (const version of [null, "", "codex-cli", "garbage"]) {
    assert.ok(
      !effortsIn(catalogWithCodex(version)).has("max"),
      `expected no max for captured_with=${JSON.stringify(version)}`,
    );
  }
});

test("a default_reasoning_level that gets filtered away clamps to a surviving rung", () => {
  // The native fixture defaults to `max`; on an old client that rung is gone, and
  // a default naming an unpublished effort is itself an unknown variant.
  const catalog = catalogWithCodex("0.130.0");
  for (const model of catalog.models) {
    const efforts = (model.supported_reasoning_levels || []).map((l) => l.effort);
    if (!efforts.length) continue;
    assert.ok(
      efforts.includes(model.default_reasoning_level),
      `${model.slug} defaults to ${model.default_reasoning_level}, which it does not publish`,
    );
  }
});

test("allowedEffortsFor drops ultra at every version", () => {
  // ultra is a backend rejection, not a client one: 0.138+ parse it happily and
  // then the request 400s. Measured 2026-08-17 against the ChatGPT backend.
  for (const version of ["0.130.0", "0.138.0", "0.145.0", "1.0.0"]) {
    assert.ok(!allowedEffortsFor(version).has("ultra"), `ultra must never survive (${version})`);
  }
  assert.ok(allowedEffortsFor("0.138.0").has("max"));
  assert.ok(!allowedEffortsFor("0.137.9").has("max"));
  assert.ok(!allowedEffortsFor("0.138.0-alpha.1").has("max"), "a prerelease sorts below its release");
});

test("the effort gate covers trial mode and the native-merge opt-out", () => {
  // Both take an early return out of catalogFor. Trial mode's default model is
  // deepseek-v4-flash-free, whose published ladder is low/high/max, so an
  // ungated early return hands a pre-0.138 client a file it cannot parse - the
  // free experience failing hardest of all.
  for (const extra of [{ trialMode: true }, { nativeMerge: false }]) {
    const catalog = catalogWithCodex("0.130.0", extra);
    const efforts = effortsIn(catalog);
    assert.ok(catalog.models.length > 0, `no models published for ${JSON.stringify(extra)}`);
    assert.ok(!efforts.has("max"), `max leaked past the gate for ${JSON.stringify(extra)}`);
    assert.ok(!efforts.has("ultra"), `ultra leaked past the gate for ${JSON.stringify(extra)}`);
  }
});
