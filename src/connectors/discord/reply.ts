import { splitReply } from "./routing.js";

interface EditableReply { edit(text: string): Promise<void> }
export interface ReplyTransport {
  reply(text: string): Promise<EditableReply>;
  followup(text: string): Promise<void>;
}

export class DiscordReply {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private placeholder: Promise<EditableReply | undefined> | undefined;
  private finished = false;
  constructor(private readonly transport: ReplyTransport) {}

  start() {
    if (!this.finished && !this.timer && !this.placeholder) {
      this.timer = setTimeout(() => { void this.working(); }, 3000);
    }
  }

  async working(): Promise<void> {
    if (this.finished) return;
    this.cancelTimer();
    this.placeholder ??= this.transport.reply("Mrrgl… Holmes checking clues. 🔎").catch(() => undefined);
    await this.placeholder;
  }

  async send(text: string) {
    this.finished = true;
    this.cancelTimer();
    const [first, ...rest] = splitReply(text);
    if (!first) return;
    const placeholder = await this.placeholder;
    if (placeholder) {
      try { await placeholder.edit(first); }
      catch { await this.transport.reply(first); }
    } else { await this.transport.reply(first); }
    for (const chunk of rest) await this.transport.followup(chunk);
  }

  close() { this.finished = true; this.cancelTimer(); }
  private cancelTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
