const fs = require("node:fs");
const path = require("node:path");
const { zipSync } = require("fflate");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const outputRoot = path.join(root, "dist");
const packageName = `${manifest.name === "__MSG_extensionName__" ? "workflow-recorder" : manifest.name}-${manifest.version}`;
const archiveRoot = "workflow-recorder";
const packageDirectory = path.join(outputRoot, packageName);
const webStorePackageName = `${packageName}-web-store`;

const extensionFiles = [
  "manifest.json",
  "LICENSE",
  ...collectFiles("_locales"),
  ...collectFiles("background"),
  ...collectFiles("content"),
  ...collectFiles("shared"),
  ...collectFiles("ui"),
  ...collectFiles("icons"),
  ...collectFiles("vendor")
];

function collectFiles(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? collectFiles(relativePath) : [relativePath];
  });
}

/**
 * Scripts injected programmatically instead of through manifest.content_scripts.
 *
 * Nothing else validates these: a renamed or moved content script would package
 * fine and only fail at record time, as an injection error in a tab the user is
 * already trying to record. Reading the list out of the module that owns it
 * keeps the check honest without duplicating the paths here.
 */
function collectInjectedFiles() {
  const source = fs.readFileSync(path.join(root, "background", "recording", "injection.js"), "utf8");
  const list = /export const INJECTION_BATCHES\s*=\s*\[([\s\S]*?)\n\];/.exec(source);
  if (!list) throw new Error("Unable to read INJECTION_BATCHES from background/recording/injection.js");

  const files = [...list[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  if (files.length === 0) throw new Error("INJECTION_BATCHES lists no files");
  return files;
}

function validateManifestFiles() {
  const packagedPaths = new Set(extensionFiles.map(toArchivePath));
  const referencedFiles = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...(manifest.content_scripts || []).flatMap(script => script.js || []),
    ...(manifest.content_scripts || []).flatMap(script => script.css || []),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...collectInjectedFiles()
  ].filter(Boolean);
  for (const referencedFile of referencedFiles) {
    if (!packagedPaths.has(referencedFile) || !fs.existsSync(path.join(root, referencedFile))) {
      throw new Error(`Manifest references a missing package file: ${referencedFile}`);
    }
  }
}

function toArchivePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

validateManifestFiles();
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(packageDirectory, { recursive: true });

const archiveFiles = {};
const webStoreArchiveFiles = {};
const webStoreManifest = { ...manifest };
delete webStoreManifest.key;
for (const relativePath of extensionFiles) {
  const source = path.join(root, relativePath);
  const destination = path.join(packageDirectory, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const archivePath = toArchivePath(relativePath);
  const bytes = new Uint8Array(fs.readFileSync(source));
  archiveFiles[`${archiveRoot}/${archivePath}`] = bytes;
  webStoreArchiveFiles[archivePath] = relativePath === "manifest.json"
    ? new TextEncoder().encode(`${JSON.stringify(webStoreManifest, null, 2)}\n`)
    : bytes;
}

const zipPath = path.join(outputRoot, `${packageName}.zip`);
const webStoreZipPath = path.join(outputRoot, `${webStorePackageName}.zip`);
// Deflate at a fixed level: fflate is deterministic for a given level, so the
// archive stays reproducible while actually being smaller than its contents.
fs.writeFileSync(zipPath, Buffer.from(zipSync(archiveFiles, { level: 9 })));
fs.writeFileSync(webStoreZipPath, Buffer.from(zipSync(webStoreArchiveFiles, { level: 9 })));
fs.writeFileSync(
  path.join(outputRoot, "package-manifest.json"),
  `${JSON.stringify({
    packageName,
    archiveRoot,
    webStorePackageName,
    webStoreManifestKeyRemoved: true,
    version: manifest.version,
    files: extensionFiles.map(toArchivePath)
  }, null, 2)}\n`
);
console.log(`Packaged ${extensionFiles.length} extension files into:`);
console.log(`- ${path.relative(root, zipPath)} (unpacked distribution)`);
console.log(`- ${path.relative(root, webStoreZipPath)} (Chrome Web Store)`);
