import type { Config } from "@netlify/functions";
import { startWorker, workerMode } from "../../src/github";

// In Modal mode the worker has its own schedule inside Modal; this only matters for the Netlify/Cobalt mode.
export default async () => {
  if (workerMode() === "netlify") await startWorker(); // local and Modal workers have their own schedule
};

export const config: Config = { schedule: "15 */3 * * *" };
