export type LinkKind = "youtube" | "instagram" | "other";

export interface ParsedLink {
  url: string;
  kind: LinkKind;
}

export function kindOf(url: string): LinkKind {
  try {
    const h = new URL(url).hostname.replace(/^www\.|^m\./, "");
    if (h === "youtu.be" || h.endsWith("youtube.com")) return "youtube";
    if (h.endsWith("instagram.com") || h === "instagr.am") return "instagram";
  } catch {
    /* fall through */
  }
  return "other";
}

/** Pull every http(s) link out of pasted text (newlines, spaces, commas), dedupe, and label it. */
export function extractLinks(text: string): ParsedLink[] {
  const seen = new Set<string>();
  const out: ParsedLink[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s,;"'<>]+/gi)) {
    const url = m[0].replace(/[).\]]+$/, "");
    try {
      new URL(url);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: kindOf(url) });
  }
  return out;
}
