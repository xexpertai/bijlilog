// Build the static app into dist/: bundle src/web/app.js and copy web/*.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("web", "dist", { recursive: true });
const r = await build({
  entryPoints: ["src/web/app.js"], bundle: true, format: "esm", platform: "browser", target: "es2022",
  minify: true, sourcemap: false, outfile: "dist/app.js", metafile: true, logLevel: "warning",
  loader: { ".wasm": "file" },
});
const bytes = Object.values(r.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`built dist/ (${(bytes / 1024).toFixed(0)} KiB of JS/assets)`);
