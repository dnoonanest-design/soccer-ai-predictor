/**
 * One place for calls to the Claude API (match explanations, player write-ups).
 *
 * - The reason for a failure goes into the log message itself, never the key.
 * - Billing and key errors pause every Claude call for a while, so a used-up
 *   credit balance does not turn into a failed call every few seconds. Rate
 *   limits and overload pause briefly.
 * - Only text blocks are read, and a reply cut off by the token limit counts
 *   as a failure, so a half sentence is never shown.
 */
import { logger } from "./logger";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const BILLING_OR_KEY_PAUSE_MS = Number(process.env.ANTHROPIC_ERROR_PAUSE_MS ?? 6 * 60 * 60_000);
const BUSY_PAUSE_MS = 5 * 60_000;

let pausedUntil = 0;
let pauseReason: string | null = null;

export type ClaudeResult = { text: string | null; error?: string; paused?: boolean };

export function anthropicKey(): string {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
}

export function claudeStatus() {
  return {
    configured: Boolean(anthropicKey()),
    pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    pauseReason: pausedUntil > Date.now() ? pauseReason : null,
  };
}

/** Pure: how long to pause after a failed call (0 = no pause). */
export function pauseForFailure(status: number, errorType: string, message: string): number {
  const text = `${errorType} ${message}`.toLowerCase();
  if (status === 401 || status === 403 || errorType === "authentication_error" || errorType === "permission_error") return BILLING_OR_KEY_PAUSE_MS;
  if (/credit|billing|balance|quota/.test(text)) return BILLING_OR_KEY_PAUSE_MS;
  if (status === 429 || status === 529 || errorType === "rate_limit_error" || errorType === "overloaded_error") return BUSY_PAUSE_MS;
  return 0;
}

export async function callClaude(prompt: string, maxTokens: number, purpose: string): Promise<ClaudeResult> {
  const key = anthropicKey();
  if (!key) return { text: null };
  if (Date.now() < pausedUntil) return { text: null, error: `Claude paused until ${new Date(pausedUntil).toISOString()}: ${pauseReason}`, paused: true };
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      let errorType = "", message = "";
      try {
        const body = (await response.json()) as { error?: { type?: string; message?: string } };
        errorType = body.error?.type ?? ""; message = body.error?.message ?? "";
      } catch { /* body not JSON */ }
      const error = `Anthropic request failed with status ${response.status}${errorType || message ? ` (${[errorType, message].filter(Boolean).join(": ").slice(0, 200)})` : ""}`.replaceAll(key, "[key]");
      const pause = pauseForFailure(response.status, errorType, message);
      if (pause > 0) {
        pausedUntil = Date.now() + pause;
        pauseReason = error;
        logger.warn({ purpose, pausedUntil: new Date(pausedUntil).toISOString() }, `Claude calls paused: ${error}`);
      } else {
        logger.warn({ purpose }, `Claude call failed: ${error}`);
      }
      return { text: null, error, paused: pause > 0 };
    }
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
    if (data.stop_reason === "max_tokens") return { text: null, error: "Claude's reply was cut off (token limit)" };
    const text = (data.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text!.trim()).join("\n").trim();
    return text ? { text } : { text: null, error: `Anthropic returned no text (stop reason: ${data.stop_reason ?? "unknown"})` };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).replaceAll(key, "[key]");
    logger.warn({ purpose }, `Claude call failed: ${error}`);
    return { text: null, error };
  }
}

/** Test hook. */
export function __resetClaudePause() { pausedUntil = 0; pauseReason = null; }
