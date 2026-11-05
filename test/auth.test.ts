import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const touched: unknown[] = [];
vi.mock("../src/db", () => ({ touchUser: async (u: unknown) => void touched.push(u) }));

import { allowedEmails, authorize, publicAuthConfig, userAuthEnabled, verifyUserToken } from "../src/auth";

const KEYS = ["CRON_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY", "ALLOWED_EMAILS"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const req = (headers: Record<string, string>) => new Request("https://site/api/queue", { headers });

beforeEach(() => {
  touched.length = 0;
  Object.assign(process.env, { CRON_SECRET: "key-123", SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", ALLOWED_EMAILS: "Me@Example.com, team@example.com" });
});
afterEach(() => { for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); vi.unstubAllGlobals(); });

function supabaseAuth(users: Record<string, { id: string; email: string }>) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe("https://proj.supabase.co/auth/v1/user");
    expect((init?.headers as Record<string, string>).apikey).toBe("anon");
    const t = String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
    return users[t] ? new Response(JSON.stringify(users[t]), { status: 200 }) : new Response("{}", { status: 401 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("settings", () => {
  it("normalises the allow-list and reports when email sign-in is on", () => {
    expect(allowedEmails()).toEqual(["me@example.com", "team@example.com"]);
    expect(userAuthEnabled()).toBe(true);
    expect(publicAuthConfig()).toEqual({ enabled: true, supabaseUrl: "https://proj.supabase.co", anonKey: "anon" });
    delete process.env.ALLOWED_EMAILS;
    expect(userAuthEnabled()).toBe(false);
    expect(publicAuthConfig()).toEqual({ enabled: false });
  });
});

describe("authorize", () => {
  it("accepts the access key without calling Supabase", async () => {
    const f = supabaseAuth({});
    expect(await authorize(req({ "x-cron-secret": "key-123" }))).toEqual({ ok: true, via: "key" });
    expect(f).not.toHaveBeenCalled();
  });

  it("accepts a signed-in allowed user and records them", async () => {
    supabaseAuth({ tok1: { id: "u1", email: "ME@example.com" } });
    const w = await authorize(req({ authorization: "Bearer tok1" }));
    expect(w).toMatchObject({ ok: true, via: "user", user: { id: "u1", email: "me@example.com" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(touched).toEqual([{ id: "u1", email: "me@example.com" }]);
  });

  it("rejects a valid sign-in whose email is not on the list", async () => {
    supabaseAuth({ tok2: { id: "u2", email: "stranger@example.com" } });
    expect(await authorize(req({ authorization: "Bearer tok2" }))).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects an invalid or expired token, a wrong key, and user tokens when sign-in is off", async () => {
    supabaseAuth({});
    expect(await authorize(req({ authorization: "Bearer nope" }))).toMatchObject({ ok: false, status: 401 });
    expect(await authorize(req({ "x-cron-secret": "wrong" }))).toMatchObject({ ok: false, status: 401 });
    process.env.ALLOWED_EMAILS = "";
    expect(await authorize(req({ authorization: "Bearer tok1" }))).toMatchObject({ ok: false, status: 401 });
  });

  it("caches a verified token for a minute", async () => {
    const f = supabaseAuth({ tokc: { id: "u3", email: "team@example.com" } });
    await verifyUserToken("tokc");
    await verifyUserToken("tokc");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
