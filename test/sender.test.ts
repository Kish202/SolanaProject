import { describe, expect, it } from "vitest";
import type { SignatureStatus } from "@solana/web3.js";
import { sendAndConfirm, type SenderRpc } from "../src/solana/sender.js";

/** Simulated chain: block height advances one per poll; the tx lands at a chosen poll. */
function fakeRpc(opts: {
  startHeight?: number;
  landAtPoll?: number;
  landedStatus?: Partial<SignatureStatus>;
  failSendTimes?: number;
  flakyStatusEvery?: number;
}) {
  let height = opts.startHeight ?? 100;
  let polls = 0;
  let sends = 0;
  const rpc: SenderRpc & { sends: () => number } = {
    sends: () => sends,
    async sendRawTransaction() {
      sends++;
      if (opts.failSendTimes && sends <= opts.failSendTimes) throw new Error("node is behind");
      return "sig";
    },
    async getSignatureStatuses() {
      polls++;
      if (opts.flakyStatusEvery && polls % opts.flakyStatusEvery === 0) throw new Error("429 Too Many Requests");
      const landed = opts.landAtPoll !== undefined && polls >= opts.landAtPoll;
      const status: SignatureStatus | null = landed
        ? { slot: 1234, confirmations: 1, err: null, confirmationStatus: "confirmed", ...opts.landedStatus }
        : null;
      return { value: [status] };
    },
    async getBlockHeight() {
      return height++;
    },
  };
  return rpc;
}

const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("sendAndConfirm", () => {
  it("confirms when the transaction lands", async () => {
    const rpc = fakeRpc({ landAtPoll: 3 });
    const clock = fakeClock();
    const res = await sendAndConfirm({ signature: "sig", rawTx: new Uint8Array(), lastValidBlockHeight: 200, rpc, ...clock });
    expect(res.status).toBe("confirmed");
  });

  it("reports failure when the tx landed with a program error", async () => {
    const rpc = fakeRpc({ landAtPoll: 2, landedStatus: { err: { InstructionError: [2, { Custom: 6001 }] } } });
    const res = await sendAndConfirm({ signature: "sig", rawTx: new Uint8Array(), lastValidBlockHeight: 200, rpc, ...fakeClock() });
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.err).toEqual({ InstructionError: [2, { Custom: 6001 }] });
  });

  it("returns expired once block height passes lastValidBlockHeight", async () => {
    const rpc = fakeRpc({ startHeight: 100 });
    const res = await sendAndConfirm({ signature: "sig", rawTx: new Uint8Array(), lastValidBlockHeight: 110, rpc, ...fakeClock() });
    expect(res.status).toBe("expired");
  });

  it("rebroadcasts the same bytes on an interval until it lands", async () => {
    const rpc = fakeRpc({ landAtPoll: 20 });
    const res = await sendAndConfirm({
      signature: "sig",
      rawTx: new Uint8Array(),
      lastValidBlockHeight: 1_000,
      rpc,
      pollIntervalMs: 500,
      rebroadcastIntervalMs: 2_000,
      ...fakeClock(),
    });
    expect(res.status).toBe("confirmed");
    expect(res.rebroadcasts).toBeGreaterThanOrEqual(4);
    expect(rpc.sends()).toBe(res.rebroadcasts + 1);
  });

  it("survives send errors and flaky status calls", async () => {
    const rpc = fakeRpc({ landAtPoll: 10, failSendTimes: 2, flakyStatusEvery: 3 });
    const res = await sendAndConfirm({ signature: "sig", rawTx: new Uint8Array(), lastValidBlockHeight: 1_000, rpc, ...fakeClock() });
    expect(res.status).toBe("confirmed");
  });

  it("fans out sends to extra broadcast RPCs", async () => {
    const rpc = fakeRpc({ landAtPoll: 1 });
    const extra = fakeRpc({});
    await sendAndConfirm({ signature: "sig", rawTx: new Uint8Array(), lastValidBlockHeight: 200, rpc, broadcastRpcs: [extra], ...fakeClock() });
    expect(extra.sends()).toBe(1);
  });

  it("waits for finalized when asked", async () => {
    const rpc = fakeRpc({ landAtPoll: 1 }); // only ever reports "confirmed"
    const res = await sendAndConfirm({
      signature: "sig",
      rawTx: new Uint8Array(),
      lastValidBlockHeight: 105,
      rpc,
      commitment: "finalized",
      ...fakeClock(),
    });
    // At expiry the final check accepts "confirmed", because the tx has definitely landed.
    expect(res.status).toBe("confirmed");
  });
});
