export const USER_MESSAGES_PER_MINUTE = 5;
export const USER_RATE_WINDOW_MS = 60_000;

export function rateLimitReply(seconds: number): string {
  return `Mrrgl! Little breather, friend. Holmes fins need rest. Try again in ${seconds} second${seconds === 1 ? "" : "s"}! 🐟`;
}
