const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("package script includes runtime directories and excludes development files", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "package.js"), "utf8");

  for (const directory of ["_locales", "background", "content", "shared", "ui", "icons", "vendor"]) {
    assert.match(source, new RegExp(`collectFiles\\(\"${directory}\"\\)`));
  }
  assert.doesNotMatch(source, /collectFiles\("(?:test|e2e|docs|scripts|node_modules)"\)/);
  assert.match(source, /validateManifestFiles\(\)/);
  assert.match(source, /fs\.rmSync\(outputRoot/);
  assert.match(source, /const archiveRoot = "workflow-recorder"/);
  assert.match(source, /const archivePath = toArchivePath\(relativePath\)/);
  assert.match(source, /archiveFiles\[`\$\{archiveRoot\}\/\$\{archivePath\}`\]/);
  // Programmatically injected content scripts are invisible to the manifest, so
  // the packager validates them separately.
  assert.match(source, /collectInjectedFiles\(\)/);
});

test("every programmatically injected content script exists", () => {
  const injection = fs.readFileSync(
    path.join(root, "background", "recording", "injection.js"),
    "utf8"
  );
  const batches = /export const INJECTION_BATCHES\s*=\s*\[([\s\S]*?)\n\];/.exec(injection);
  assert.ok(batches, "INJECTION_BATCHES must stay statically readable for the packager");

  const files = [...batches[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `injected file is missing: ${file}`);
  }
});

test("project declares Node 20 and reproducible verification commands", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.build, "npm run package");
  assert.equal(pkg.scripts.lint, "node scripts/check-js.js");
  assert.equal(pkg.scripts.package, "node scripts/package.js");
});

test("extension, npm package and lockfile versions stay in sync", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  // npm accepts a UTF-8 BOM in lockfiles; normalize it for JSON.parse as well.
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8").replace(/^\uFEFF/, ""));
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});
