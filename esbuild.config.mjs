import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";

// main.js is built at the repo root (where a GitHub release picks it up, next to manifest.json and styles.css)
// and copied into dist/ together with them — .obsidian/plugins/project-pulse is a symlink to dist/ for local use.
const prod = process.argv[2] === "production";

mkdirSync("dist", { recursive: true });
const copyStatic = () => {
	copyFileSync("main.js", "dist/main.js");
	copyFileSync("manifest.json", "dist/manifest.json");
	copyFileSync("styles.css", "dist/styles.css");
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
	],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	plugins: [
		{
			name: "copy-static",
			setup(build) {
				build.onEnd(copyStatic);
			},
		},
	],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
