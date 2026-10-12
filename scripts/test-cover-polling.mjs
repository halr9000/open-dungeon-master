import assert from "node:assert/strict";
import { pollUntilSettled } from "../src/lib/poll-until-settled.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Equal pending values must continue to poll until the job changes state.
const states = ["queued", "queued", "generating", "generating", "ready"];
const seen = [];
await new Promise((resolve) => {
  pollUntilSettled(
    async () => states[seen.length],
    (state) => state === "queued" || state === "generating",
    (state) => {
      seen.push(state);
      if (state === "ready") resolve();
    },
    1,
    8,
  );
});
assert.deepEqual(seen, states);

// A transient read failure consumes one bounded attempt but does not stop the loop.
let requests = 0;
const recovered = [];
await new Promise((resolve) => {
  pollUntilSettled(
    async () => {
      requests += 1;
      if (requests === 1) throw new Error("temporary read failure");
      return requests === 2 ? "generating" : "ready";
    },
    (state) => state === "generating",
    (state) => {
      recovered.push(state);
      if (state === "ready") resolve();
    },
    1,
    3,
  );
});
assert.deepEqual(recovered, ["generating", "ready"]);
assert.equal(requests, 3);

// The attempt limit is honored after repeated failed reads.
let failedRequests = 0;
pollUntilSettled(
  async () => {
    failedRequests += 1;
    throw new Error("offline");
  },
  () => true,
  () => assert.fail("failed reads cannot deliver a value"),
  1,
  3,
);
await delay(100);
assert.equal(failedRequests, 3);

// Unmount cleanup cancels a scheduled poll.
let cancelledRequests = 0;
const stop = pollUntilSettled(
  async () => {
    cancelledRequests += 1;
    return "queued";
  },
  () => true,
  () => {},
  20,
  3,
);
stop();
await delay(30);
assert.equal(cancelledRequests, 0);

console.log("test-cover-polling: 4 polling behaviors passed");
