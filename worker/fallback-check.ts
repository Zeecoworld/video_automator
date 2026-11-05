import fs from "node:fs";
import { fallbackNeeded } from "../src/maintenance";

/** Prints needed=true|false (and writes it to $GITHUB_OUTPUT) so the Actions job only spends minutes when the main worker is behind. */
const needed = await fallbackNeeded().catch((e) => {
  console.error(`fallback check failed: ${(e as Error).message}`);
  return false;
});
console.log(`needed=${needed}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
process.exit(0);
