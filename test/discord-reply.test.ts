import { afterEach, expect, it, vi } from "vitest";
import { DiscordReply } from "../src/connectors/discord/reply.js";

afterEach(() => vi.useRealTimers());
function setup() {
  const edit = vi.fn(async (_text: string) => {});
  const reply = vi.fn(async (_text: string) => ({ edit }));
  const followup = vi.fn(async (_text: string) => {});
  return { delivery: new DiscordReply({ reply, followup }), reply, edit, followup };
}

it("sends fast answers directly and never posts a late placeholder", async () => {
  vi.useFakeTimers();
  const { delivery, reply, edit } = setup();
  delivery.start();
  await delivery.send("Answer");
  await vi.advanceTimersByTimeAsync(4000);
  expect(reply).toHaveBeenCalledExactlyOnceWith("Answer");
  expect(edit).not.toHaveBeenCalled();
});

it("edits a delayed working reply into the final answer", async () => {
  vi.useFakeTimers();
  const { delivery, reply, edit } = setup();
  delivery.start();
  await vi.advanceTimersByTimeAsync(3000);
  await delivery.send("Final answer");
  expect(reply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("checking clues"));
  expect(edit).toHaveBeenCalledExactlyOnceWith("Final answer");
});

it("starts working immediately for a tool, deduplicates progress, and splits a long answer", async () => {
  const { delivery, reply, edit, followup } = setup();
  await Promise.all([delivery.working(), delivery.working()]);
  await delivery.send("a".repeat(4500));
  expect(reply).toHaveBeenCalledTimes(1);
  expect(edit).toHaveBeenCalledWith("a".repeat(2000));
  expect(followup.mock.calls.map(call => call[0]).join("")).toBe("a".repeat(2500));
});

it("waits for an in-flight placeholder before replacing it with an error", async () => {
  const edit = vi.fn(async (_text: string) => {});
  let resolve!: (value: { edit: typeof edit }) => void;
  const reply = vi.fn((_text: string) => new Promise<{ edit: typeof edit }>(ready => { resolve = ready; }));
  const delivery = new DiscordReply({ reply, followup: async () => {} });
  const working = delivery.working();
  const finish = delivery.send("Could not finish");
  resolve({ edit });
  await Promise.all([working, finish]);
  expect(edit).toHaveBeenCalledExactlyOnceWith("Could not finish");
  expect(reply).toHaveBeenCalledTimes(1);
});

it("falls back to a fresh reply if someone deleted the placeholder", async () => {
  const { delivery, reply, edit } = setup();
  edit.mockRejectedValueOnce(new Error("deleted"));
  await delivery.working();
  await delivery.send("Final answer");
  expect(reply).toHaveBeenLastCalledWith("Final answer");
});

it("cleans up a pending timer", async () => {
  vi.useFakeTimers();
  const { delivery, reply } = setup();
  delivery.start();
  delivery.close();
  await vi.advanceTimersByTimeAsync(4000);
  expect(reply).not.toHaveBeenCalled();
});
