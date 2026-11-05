export function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const opt = (name: string): string | undefined => process.env[name] || undefined;

/** True inside Netlify/AWS Lambda functions (small disk, short limits). */
export const serverless = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

export type AiProvider = "auto" | "gemini" | "none";

/**
 * auto   (default) = transcribe with the first working of Groq / Hugging Face / local Faster-Whisper, then choose the moments with the
 *                    first working text model (Groq / Gemini / Hugging Face / custom), then a rule-based picker. If no transcript can be
 *                    made and GEMINI_API_KEY is set, Gemini listens to the audio directly as a last resort.
 * gemini           = only the Gemini audio path (no subtitles).
 * none             = fixed-length clips.
 */
export function aiProvider(): AiProvider {
  const v = process.env.AI_PROVIDER;
  return v === "gemini" || v === "none" ? v : "auto";
}
