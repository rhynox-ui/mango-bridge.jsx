// extension/package.mjs
//
// Builds the popup bundle, then zips this whole directory into
// public/mango-wallet-extension.zip — a real, working "Load unpacked"
// bundle, not a placeholder. Vite copies everything under public/ into
// the site's build output verbatim, so this zip ships as a normal static
// download once the site itself is built.
//
// This is the honest distribution path until the extension goes through
// the Chrome Web Store's review process (a manual submission this repo
// can't do on its own) — same "real thing, not a fake button" standard
// the rest of this project holds to. The in-app "Get the extension"
// modal (see MangoWallet.jsx's ExtensionModal) says exactly that.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(dir, "..", "public");
const zipPath = path.join(publicDir, "mango-wallet-extension.zip");

execFileSync(process.execPath, [path.join(dir, "build.mjs")], { stdio: "inherit" });

fs.mkdirSync(publicDir, { recursive: true });
fs.rmSync(zipPath, { force: true });

// Zips extension/'s own contents at the archive root (so "Load unpacked"
// on the extracted folder finds manifest.json directly) — excludes the
// packaging/build tooling itself and the source map, neither of which
// the extension needs at runtime.
execFileSync("zip", ["-r", zipPath, ".", "-x", "package.mjs", "-x", "build.mjs", "-x", "shims/*", "-x", "popup.bundle.js.map"], {
  cwd: dir,
  stdio: "inherit",
});

console.log(`Packaged ${path.relative(path.join(dir, ".."), zipPath)}`);
