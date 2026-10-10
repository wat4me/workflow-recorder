const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const zh = JSON.parse(fs.readFileSync(path.join(root, "_locales", "zh_CN", "messages.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "_locales", "en", "messages.json"), "utf8"));

test("Chinese and English locales expose the same messages", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.equal(zh.noSteps.message, "暂无录制步骤。");
  assert.equal(en.noSteps.message, "No steps recorded yet.");
  assert.equal(zh.workspace.message, "工作台");
  assert.equal(en.workspace.message, "Workspace");
});

test("public AI copy instructions do not require internal skills", () => {
  for (const locale of [zh, en]) {
    for (const key of ["copyTaskHint", "agentManualModeHint"]) {
      assert.doesNotMatch(locale[key].message, /test-base|\bskills?\b/i);
      assert.match(locale[key].message, /Markdown/);
    }
  }
  assert.match(zh.copyTaskHint.message, /不会复制录制截图/);
  assert.match(en.copyTaskHint.message, /Screenshots are not copied/);
});

test("the screenshot update label identifies the after frame and its page scope", () => {
  assert.equal(zh.manualScreenshot.message, "更新操作后截图");
  assert.match(zh.manualScreenshotTitle.message, /当前页面最后一个操作的操作后截图.*不改变操作前截图/);
  assert.match(en.manualScreenshotTitle.message, /last operation on the current page, without changing its before-action screenshot/);
});

test("all interface localization keys exist", () => {
  // Discovered by walking the source tree rather than from a hand-maintained
  // list: a list silently stops covering any file added or moved after it.
  const files = collectSources(["background", "content", "shared", "ui"]);
  assert.ok(files.length > 20, `expected to scan the whole source tree, found ${files.length} files`);

  const keys = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\("([A-Za-z0-9_]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="([A-Za-z0-9_]+)"/g)) {
      keys.add(match[1]);
    }
  }

  const missing = [...keys].filter(key => !zh[key] || !en[key]);
  assert.deepEqual(missing, []);
});

function collectSources(directories) {
  return directories.flatMap(directory => walk(path.join(root, directory)))
    .filter(file => /\.(?:js|html)$/.test(file));
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
