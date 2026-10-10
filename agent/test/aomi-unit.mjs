import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
} from "viem";
import { mandateCalls, verifyMandateEvents } from "../src/aomi.js";
import { MANDATE_ABI } from "../src/chain.js";
import { preflightCall } from "../src/executor.js";

const mandate = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const inner = { label: "deposit", target, data: "0x12345678aabbccdd" };

function log(eventName, args, data = "0x") {
  return {
    address: mandate,
    topics: encodeEventTopics({ abi: MANDATE_ABI, eventName, args }),
    data,
  };
}

test("wraps the deterministic Mandate plan without changing target or calldata", () => {
  const [outer] = mandateCalls(mandate, [inner]);
  assert.equal(outer.to, mandate);
  assert.equal(outer.value, "0");
  const decoded = decodeFunctionData({ abi: MANDATE_ABI, data: outer.data });
  assert.equal(decoded.functionName, "execute");
  assert.deepEqual(decoded.args, [target, inner.data]);
});

test("requires the exact Executed event and rejects breach evidence", () => {
  const executed = log(
    "Executed",
    { target, selector: inner.data.slice(0, 10) },
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [10n, 11n]),
  );
  const event = verifyMandateEvents({ logs: [executed] }, mandate, inner);
  assert.equal(event.args.navAfter, 11n);
  const breach = log(
    "Breach",
    { reason: `0x${"00".repeat(32)}`, target },
    encodeAbiParameters([{ type: "bytes4" }], [inner.data.slice(0, 10)]),
  );
  assert.throws(
    () => verifyMandateEvents({ logs: [executed, breach] }, mandate, inner),
    /Breach or CallReverted/,
  );
});

test("keeps Mandate's existing preflight as the final gate before Circle execution", async () => {
  const calls = [];
  const result = await preflightCall({
    pub: {
      simulateContract: async (request) => {
        calls.push(request);
        return { result: false };
      },
      call: async () => {
        throw new Error("venue refused");
      },
    },
    account: "0x3333333333333333333333333333333333333333",
    snap: { mandate },
    call: inner,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.result.status, "PREFLIGHT_BLOCKED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].account, "0x3333333333333333333333333333333333333333");
  assert.deepEqual(calls[0].args, [target, inner.data]);
});
