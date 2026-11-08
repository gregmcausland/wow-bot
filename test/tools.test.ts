import { afterEach, expect, it, vi } from "vitest";
import { createTools } from "../src/core/tools.js";

afterEach(() => vi.useRealTimers());

it("returns a real current time in a named timezone without injecting it into the prompt", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  const tools = createTools({}, new AbortController().signal);
  expect(await tools.current_time.execute!({ timezone: "UTC" }, { toolCallId: "1", messages: [], context: {} }))
    .toMatchObject({ status: "ok", utc: "2026-10-30T12:00:00.000Z", timezone: "UTC" });
  expect(await tools.current_time.execute!({ timezone: "not/a/timezone" }, { toolCallId: "2", messages: [], context: {} }))
    .toMatchObject({ status: "unavailable" });
});

it("reports absent chat honestly and stops executing after the tool-call budget", async () => {
  const tools = createTools({}, new AbortController().signal);
  expect(await tools.read_recent_chat.execute!({ limit: 20 }, { toolCallId: "0", messages: [], context: {} }))
    .toMatchObject({ status: "unavailable", reason: expect.stringContaining("No Discord chat") });
  for (let index = 0; index < 5; index++) {
    await tools.current_time.execute!({ timezone: "UTC" }, { toolCallId: String(index), messages: [], context: {} });
  }
  expect(await tools.current_time.execute!({ timezone: "UTC" }, { toolCallId: "7", messages: [], context: {} }))
    .toMatchObject({ status: "unavailable", reason: expect.stringContaining("budget") });
});
