import { createHash } from "node:crypto";
import { authorized } from "./http";

export interface Who {
  ok: boolean;
  via?: "key" | "user";
  user?: { id: string; email: string };
  status?: number;
  error?: string;
}

export const allowedEmails = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Email sign-in is on when Supabase Auth's anon key and an allow-list are set. The access key keeps working either way. */
export const userAuthEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && allowedEmails(env).length);

const tokenCache = new Map<string, { exp: number; user: { id: string; email: string } | null }>();
const touched = new Map<string, number>();

/** Ask Supabase Auth who a session token belongs to (cached for a minute). */
export async function verifyUserToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; email: string } | null> {
  const k = createHash("sha256").update(token).digest("hex");
  const hit = tokenCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.user;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY ?? "", Authorization: `Bearer ${token}` } });
  let user: { id: string; email: string } | null = null;
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as { id?: string; email?: string } | null;
    if (j?.id && j.email) user = { id: j.id, email: j.email.toLowerCase() };
  }
  tokenCache.set(k, { exp: Date.now() + 60_000, user });
  return user;
}

/** Dashboard endpoints: the shared access key, or a signed-in user whose email is on the allow-list. */
export async function authorize(req: Request): Promise<Who> {
  if (authorized(req)) return { ok: true, via: "key" };
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && userAuthEnabled()) {
    const user = await verifyUserToken(bearer);
    if (!user) return { ok: false, status: 401, error: "Your sign-in expired. Please sign in again." };
    if (!allowedEmails().includes(user.email)) return { ok: false, status: 403, error: `${user.email} is not on the allowed list.` };
    if ((touched.get(user.id) ?? 0) < Date.now() - 10 * 60_000) {
      touched.set(user.id, Date.now());
      import("./db").then((db) => db.touchUser(user)).catch(() => undefined); // best effort: the users table may not exist yet
    }
    return { ok: true, via: "user", user };
  }
  return { ok: false, status: 401, error: "unauthorized" };
}

export const publicAuthConfig = (env: NodeJS.ProcessEnv = process.env) =>
  userAuthEnabled(env) ? { enabled: true, supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY } : { enabled: false };

