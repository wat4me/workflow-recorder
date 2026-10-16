const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const localDirectory = path.join(root, ".local");
const keyDirectory = path.join(os.homedir(), ".extension-keys", "workflow-recorder");
const privateKeyPath = path.join(keyDirectory, "extension-key.pem");
const identityPath = path.join(localDirectory, "extension-identity.json");
const manifestPath = path.join(root, "manifest.json");

function extensionId(publicKeyDer) {
  const digest = crypto.createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
  return [...digest]
    .flatMap(byte => [byte >> 4, byte & 0x0f])
    .map(nibble => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

function loadOrCreatePrivateKey() {
  if (fs.existsSync(privateKeyPath)) {
    return crypto.createPrivateKey(fs.readFileSync(privateKeyPath, "utf8"));
  }

  if (!process.argv.includes("--create")) {
    throw new Error(
      `没有找到开发版扩展私钥: ${privateKeyPath}\n`
      + "请从安全备份恢复该私钥。只有首次建立新扩展身份时才运行 npm run extension:key:create。"
    );
  }

  fs.mkdirSync(keyDirectory, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001
  });
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600
  });
  return privateKey;
}

const privateKey = loadOrCreatePrivateKey();
const publicKeyDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
const manifestKey = publicKeyDer.toString("base64");
const id = extensionId(publicKeyDer);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.key !== manifestKey) {
  manifest.key = manifestKey;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
fs.mkdirSync(localDirectory, { recursive: true });
fs.writeFileSync(identityPath, `${JSON.stringify({
  extensionId: id,
  manifestKey,
  privateKeyPath
}, null, 2)}\n`);

console.log(JSON.stringify({
  extensionId: id,
  manifestKey,
  privateKeyPath,
  identityPath
}, null, 2));
