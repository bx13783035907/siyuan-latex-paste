import esbuild from "esbuild";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 单元测试用未压缩的产物，方便看 diff
await esbuild.build({
  entryPoints: [path.join(root, "src", "latex.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  outfile: path.join(root, "test", ".build", "latex.mjs"),
  logLevel: "warning",
});

// 集成测试要跑真实的构建产物
const build = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
  stdio: "inherit",
  cwd: root,
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "test/latex.test.mjs", "test/plugin.test.mjs"],
  { stdio: "inherit", cwd: root },
);

process.exit(result.status ?? 1);
