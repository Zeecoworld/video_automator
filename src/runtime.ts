import fs from "node:fs";
import path from "node:path";

/** Resolve a file bundled with the function (netlify.toml `included_files`) or from the project root in dev. */
export function assetPath(rel: string): string {
  const roots = [process.env.LAMBDA_TASK_ROOT, process.cwd(), path.resolve(import.meta.dirname ?? ".", "..")].filter(Boolean) as string[];
  for (const r of roots) {
    const p = path.join(r, rel);
    if (fs.existsSync(p)) return p;
  }
  return path.join(roots[0] ?? ".", rel);
}

export const log = {
  info: (...a: unknown[]) => console.log("[info]", ...a),
  warn: (...a: unknown[]) => console.warn("[warn]", ...a),
  error: (...a: unknown[]) => console.error("[error]", ...a),
};
