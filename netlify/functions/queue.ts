import type { Config } from "@netlify/functions";
import * as db from "../../src/db";
import { authorize } from "../../src/auth";
import { json, safe } from "../../src/http";

export default safe(async (req: Request) => {
  const who = await authorize(req);
  if (!who.ok) return json({ error: who.error }, who.status ?? 401);
  return json({ stats: await db.stats(), ...(await db.queueView()) });
});

export const config: Config = { path: "/api/queue" };
