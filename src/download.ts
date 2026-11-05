import type { Config } from "./config";
import { opt } from "./env";
import { downloadViaCobalt } from "./cobalt";
import { downloadVideo, type Download } from "./ytdlp";

/** Cobalt (a download API, no binaries) when COBALT_API_URL is set; yt-dlp otherwise (self-hosted worker). */
export function downloaderName(): "cobalt" | "ytdlp" {
  const forced = opt("DOWNLOADER");
  if (forced === "cobalt" || forced === "ytdlp") return forced;
  return opt("COBALT_API_URL") ? "cobalt" : "ytdlp";
}

export function download(url: string, dir: string, cfg: Config): Promise<Download> {
  return downloaderName() === "cobalt" ? downloadViaCobalt(url, dir, cfg) : downloadVideo(url, dir, cfg);
}
