import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(projectRoot, "src-tauri", "runtime");
const modulesRoot = join(projectRoot, "node_modules");

const runtimePackages = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-node",
  "@connectrpc/connect-web",
  "@cursor/sdk",
  "@cursor/sdk-win32-x64",
  "@statsig/client-core",
  "@statsig/js-client",
  "undici",
  "zod",
];

function copyRequired(source, destination, label) {
  if (!existsSync(source)) {
    throw new Error(`Cannot stage Cursor runtime: missing ${label} at ${source}. Run npm install first.`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

copyRequired(
  join(projectRoot, "scripts", "cursor-bridge.mjs"),
  join(runtimeRoot, "scripts", "cursor-bridge.mjs"),
  "Cursor bridge",
);
copyRequired(
  join(modulesRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
  join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node"),
  "pinned Node runtime",
);

for (const dependency of runtimePackages) {
  copyRequired(
    join(modulesRoot, ...dependency.split("/")),
    join(runtimeRoot, "node_modules", ...dependency.split("/")),
    dependency,
  );
}

writeFileSync(
  join(runtimeRoot, "THIRD-PARTY-NOTICES.txt"),
  [
    "Hormachuelos bundled Cursor runtime",
    "",
    "Node.js 24.14.1 and npm dependencies are redistributed under the license declared by each package.",
    "Package license files and metadata are retained inside runtime/node_modules.",
    "Node.js license and notices: https://github.com/nodejs/node/blob/v24.14.1/LICENSE",
    "Cursor SDK package metadata: runtime/node_modules/@cursor/sdk/package.json",
    "",
    "Video attachment frame-sampling workflow inspired by claude-video by Bradley Bonanno (MIT):",
    "https://github.com/bradautomates/claude-video",
    "Hormachuelos uses browser media APIs for its implementation; no claude-video source files are bundled.",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`Staged self-contained Cursor runtime at ${runtimeRoot}`);
