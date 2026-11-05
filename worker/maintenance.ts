import { runMaintenance } from "../src/maintenance";

try {
  await runMaintenance();
  process.exit(0);
} catch (e) {
  console.error(`maintenance failed: ${(e as Error).message}`);
  process.exit(1);
}
