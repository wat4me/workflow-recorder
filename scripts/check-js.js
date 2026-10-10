const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceDirectories = ["background", "content", "shared", "ui", "scripts", "test", "e2e"];

function collectJavaScriptFiles(directory) {
  const absoluteDirectory = path.join(root, directory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(relativePath);
    return entry.name.endsWith(".js") ? [relativePath] : [];
  });
}

const files = sourceDirectories.flatMap(collectJavaScriptFiles);
let failed = false;
for (const relativePath of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
else console.log(`Checked ${files.length} JavaScript files.`);
