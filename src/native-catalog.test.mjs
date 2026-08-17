import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { desktopCodexCandidates, nativeCatalogPath, nativeModelSlugs, parseCodexVersion, readNativeCatalog } from "./native-catalog.mjs";

function writeCapture(file, models) {
  writeFileSync(file, JSON.stringify({ captured_with: "0.1.0", models }), "utf8");
}

test("readNativeCatalog returns null for a missing cache and a corrupt cache", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const missing = path.join(dir, "missing.json");
    assert.equal(readNativeCatalog({ nativeCatalogFile: missing }), null);
    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    assert.equal(readNativeCatalog({ nativeCatalogFile: corrupt }), null);
    const wrongShape = path.join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ models: "nope" }), "utf8");
    assert.equal(readNativeCatalog({ nativeCatalogFile: wrongShape }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nativeCatalogPath honors the config override and otherwise defaults under ~/.modeldock", () => {
  const override = path.join(os.tmpdir(), "modeldock-native-override.json");
  assert.equal(nativeCatalogPath({ nativeCatalogFile: override }), override);
  assert.equal(
    nativeCatalogPath({}),
    path.join(os.homedir(), ".modeldock", "native-catalog.json"),
  );
});

test("nativeModelSlugs includes every captured slug, hidden or not", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-5.4-mini", visibility: "hide" },
      { slug: "codex-auto-review", visibility: "hide" },
    ]);
    const slugs = nativeModelSlugs({ nativeCatalogFile: file });
    assert.deepEqual([...slugs].sort(), ["codex-auto-review", "gpt-5.4-mini", "gpt-5.6-sol"]);
    assert.equal(nativeModelSlugs({ nativeCatalogFile: path.join(dir, "missing.json") }).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktopCodexCandidates covers the bundled Windows and macOS CLIs", () => {
  const mac = desktopCodexCandidates("darwin");
  assert.ok(
    mac.some((candidate) => candidate.endsWith(path.join("ChatGPT.app", "Contents", "Resources", "codex"))),
    "macOS must include the ChatGPT.app bundled Codex CLI",
  );

  const win = desktopCodexCandidates("win32");
  assert.ok(win.every((candidate) => candidate.endsWith("codex.exe")), "Windows candidates must point at codex.exe");
});

test("parseCodexVersion picks the version out of the CLI banner", () => {
  // `codex --version` prints "codex-cli 0.145.0", so taking the first
  // whitespace-separated token yields "codex-cli" and the real version is lost.
  // Observed on 2026-08-18: the cached capture at ~/.modeldock/native-catalog.json
  // carried captured_with: "codex-cli". Harmless while the value was only a
  // cosmetic stamp, but it is about to gate which reasoning efforts are published.
  assert.equal(parseCodexVersion("codex-cli 0.145.0"), "0.145.0");
  assert.equal(parseCodexVersion("codex-cli 0.145.0\n"), "0.145.0");
  assert.equal(parseCodexVersion("0.130.0"), "0.130.0", "a bare version still parses");
  assert.equal(parseCodexVersion("codex-cli 0.142.5 (abc1234)"), "0.142.5", "trailing build metadata is ignored");
});

test("parseCodexVersion returns empty for anything it cannot read", () => {
  // The caller treats "" as "version unknown" and falls back to the safe policy,
  // so a wrong guess here is worse than no answer.
  for (const input of ["", "   ", "codex-cli", "not a version", null, undefined]) {
    assert.equal(parseCodexVersion(input), "", `expected "" for ${JSON.stringify(input)}`);
  }
});
