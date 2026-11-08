import { expect, it, vi } from "vitest";
import { RequestQueue, RequestQueueFull } from "../src/core/request-queue.js";

it("allows two active requests and starts queued work when a slot opens", async () => {
  const queue = new RequestQueue();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const task = vi.fn(() => blocked);
  const requests = [queue.run("a", task), queue.run("b", task), queue.run("c", task)];
  await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
  release();
  await Promise.all(requests);
  expect(task).toHaveBeenCalledTimes(3);
});

it("bounds each conversation's backlog and recovers after failure", async () => {
  const queue = new RequestQueue();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const requests = Array.from({ length: 4 }, () => queue.run("a", () => blocked));
  await expect(queue.run("a", async () => {})).rejects.toBeInstanceOf(RequestQueueFull);
  release();
  await Promise.all(requests);
  await expect(queue.run("a", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  await expect(queue.run("a", async () => {})).resolves.toBeUndefined();
});

it("bounds pending work across conversations", async () => {
  const queue = new RequestQueue();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const requests = Array.from({ length: 16 }, (_, i) => queue.run(String(i), () => blocked));
  await expect(queue.run("overflow", async () => {})).rejects.toBeInstanceOf(RequestQueueFull);
  release();
  await Promise.all(requests);
  await queue.drain();
});
