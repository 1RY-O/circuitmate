// Minimal prod build step 2/2: `tsc` emits JS to dist/, then this copies the
// runtime assets tsc doesn't handle (static UI + knowledge JSONs) so that
// `npm run start:prod` (node dist/src/server.js) resolves the same paths as dev.
// Run via: npm run build
import { cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

mkdirSync(join(root, "dist", "public"), { recursive: true });
cpSync(join(root, "public"), join(root, "dist", "public"), { recursive: true });
mkdirSync(join(root, "dist", "src", "knowledge"), { recursive: true });
cpSync(join(root, "src", "knowledge"), join(root, "dist", "src", "knowledge"), { recursive: true });

// .env is git-ignored and stays at the project root; the server also loads
// process.cwd()/.env first, so start prod from the project root.
console.log("build assets copied to dist/ (run from repo root: npm run start:prod)");
