import type { Config } from "@netlify/functions";
import { authorize } from "../../src/auth";
import { json, safe } from "../../src/http";
import { opt, req as env } from "../../src/env";
import { log } from "../../src/runtime";
import * as yt from "../../src/youtube-auth";

const back = (query: string) => {
  const site = (() => {
    try {
      return yt.siteUrl();
    } catch {
      return "/";
    }
  })();
  return new Response(null, { status: 302, headers: { Location: `${site}/?${query}` } });
};

/**
 *  POST /api/auth/youtube/url         -> { url }  Google consent screen URL (needs the access key)
 *  GET  /api/auth/youtube/callback    <- Google redirects here (protected by the signed state)
 *  GET  /api/auth/youtube/status      -> who is connected (needs the access key)
 *  POST /api/auth/youtube/disconnect  -> revoke + forget (needs the access key)
 */
export default safe(async (request: Request) => {
  const url = new URL(request.url);
  const action = url.pathname.replace(/\/+$/, "").split("/").pop();

  if (action === "callback") {
    try {
      const secret = env("CRON_SECRET");
      const error = url.searchParams.get("error");
      if (error) return back(`youtube=error&msg=${encodeURIComponent(error === "access_denied" ? "Sign-in was cancelled." : error)}`);
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      if (!code || !yt.verifyState(secret, state)) {
        return back(`youtube=error&msg=${encodeURIComponent("That sign-in link expired or is invalid. Press Connect YouTube again.")}`);
      }
      const conn = await yt.completeSignIn(code);
      log.info(`YouTube connected: ${conn.channel_title}`);
      return back("youtube=connected");
    } catch (e) {
      log.error(`YouTube sign-in failed: ${(e as Error).message}`);
      return back(`youtube=error&msg=${encodeURIComponent(String((e as Error).message).slice(0, 200))}`);
    }
  }

  const who = await authorize(request);
  if (!who.ok) return json({ error: who.error }, who.status ?? 401);

  if (action === "url" && request.method === "POST") {
    const clientId = opt("YT_CLIENT_ID");
    if (!clientId || !opt("YT_CLIENT_SECRET")) return json({ error: "Set YT_CLIENT_ID and YT_CLIENT_SECRET in Netlify first." }, 400);
    return json({ url: yt.buildAuthUrl(clientId, yt.redirectUri(), yt.signState(env("CRON_SECRET"))) });
  }

  if (action === "status" && request.method === "GET") {
    let redirect: string | undefined;
    try {
      redirect = yt.redirectUri();
    } catch {
      /* SITE_URL missing */
    }
    const conn = await yt.loadConnection();
    return json({
      configured: Boolean(opt("YT_CLIENT_ID") && opt("YT_CLIENT_SECRET")),
      connected: Boolean(conn || opt("YT_REFRESH_TOKEN")),
      source: conn ? "dashboard" : opt("YT_REFRESH_TOKEN") ? "env" : null,
      channelTitle: conn?.channel_title ?? null,
      thumbnail: conn?.thumbnail || null,
      connectedAt: conn?.connected_at ?? null,
      redirectUri: redirect,
    });
  }

  if (action === "disconnect" && request.method === "POST") {
    const conn = await yt.loadConnection();
    if (conn) await yt.revoke(conn.refresh_token);
    await yt.clearConnection();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
});

export const config: Config = { path: "/api/auth/youtube/*" };
