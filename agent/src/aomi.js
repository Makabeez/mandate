import fs from "node:fs";
import path from "node:path";
import { decodeEventLog, encodeFunctionData, keccak256, stringToHex } from "viem";
import { TaskClient, parseSmartAccountArtifact } from "arc-canteen/task-client";
import { CircleArcWallet, verifyArcCallReceipt } from "arc-canteen/circle-arc-wallet";
import { MANDATE_ABI } from "./chain.js";
import { preflightCall } from "./executor.js";

const lower = (value) => value.toLowerCase();

function decodedMandateEvents(logs, mandate) {
  return logs.flatMap((log) => {
    if (lower(String(log.address)) !== lower(mandate)) return [];
    try {
      return [decodeEventLog({ abi: MANDATE_ABI, data: log.data, topics: log.topics })];
    } catch {
      return [];
    }
  });
}

export function mandateCalls(mandate, calls) {
  return calls.map((call) => ({
    to: mandate,
    data: encodeFunctionData({
      abi: MANDATE_ABI,
      functionName: "execute",
      args: [call.target, call.data],
    }),
    value: "0",
  }));
}

export function verifyMandateEvents(receipt, mandate, plannedCall) {
  const events = decodedMandateEvents(receipt.logs, mandate);
  if (events.some((event) => event.eventName === "Breach" || event.eventName === "CallReverted")) {
    throw new Error("Mandate emitted Breach or CallReverted");
  }
  const executed = events.filter((event) => event.eventName === "Executed");
  const selector = plannedCall.data.slice(0, 10).toLowerCase();
  if (
    executed.length !== 1
    || lower(executed[0].args.target) !== lower(plannedCall.target)
    || executed[0].args.selector.toLowerCase() !== selector
  ) {
    throw new Error("Arc receipt is missing the exact Mandate Executed event");
  }
  return executed[0];
}

export class AomiMandateExecutor {
  constructor({ cfg, pub, log }) {
    this.cfg = cfg;
    this.pub = pub;
    this.log = log;
    this.wallet = new CircleArcWallet({
      walletAddress: cfg.aomi.walletAddress,
      command: cfg.aomi.circleCommand,
    });
    this.trustedJwks = JSON.parse(fs.readFileSync(cfg.aomi.trustedJwksFile, "utf8"));
  }

  async run({ snap, calls }) {
    const outerCalls = mandateCalls(snap.mandate, calls);
    const payer = await this.wallet.gatewayPayer();
    const fingerprint = keccak256(stringToHex(JSON.stringify({ version: 3, payer, outerCalls })));
    const stateDirectory = path.join(
      this.cfg.aomi.stateDirectory,
      lower(snap.mandate),
      fingerprint.slice(2),
    );
    const request = {
      executionKind: "smart_account_calls",
      intent: `Verify and freeze MandateAccount ${snap.mandate} plan ${fingerprint}`,
      chainId: this.cfg.chainId,
      sender: this.wallet.walletAddress,
      payer,
      calls: outerCalls,
      constraints: {
        maxOutgoingUsdcWei: "0",
        maxGasUnits: this.cfg.aomi.maxGasUnits,
        allowedTargets: [snap.mandate],
        minimumReceived: [],
      },
    };
    const client = new TaskClient({
      endpoint: this.cfg.aomi.endpoint,
      payer,
      recipient: this.cfg.aomi.seller,
      maxFeeMicrousd: this.cfg.aomi.maxFeeMicrousd,
      trustedJwks: this.trustedJwks,
      stateDirectory,
      signTypedData: (typedData) => this.wallet.signTypedData(typedData, (review) => {
        this.log(`  Circle review: ${review.title}`);
        return true;
      }),
    });
    const quote = await client.prepare(request);
    this.log(`  Aomi quote ${quote.quoteId} fee ${quote.pricing.fee_microusd} micro-USDC`);
    const purchased = await client.purchase(request);
    if (purchased.status === "pending") {
      return { ok: false, results: calls.map((call) => ({ ...call, status: "AOMI_PAYMENT_PENDING" })) };
    }
    const artifact = parseSmartAccountArtifact(purchased.bytes, request, quote);
    const results = [];
    for (let index = 0; index < artifact.calls.length; index += 1) {
      const outer = artifact.calls[index];
      const inner = calls[index];
      const preflight = await preflightCall({
        pub: this.pub,
        account: this.wallet.walletAddress,
        snap,
        call: inner,
        log: this.log,
      });
      if (!preflight.ok) return { ok: false, results: [...results, preflight.result] };
      const circle = await this.wallet.executeContractCall({
        chainId: this.cfg.chainId,
        to: outer.to,
        data: outer.data,
        value: outer.value,
        abiFunctionSignature: "execute(address,bytes)",
        abiParameters: [inner.target, inner.data],
        idempotencyKey: `mandate-${artifact.artifactHash.slice(0, 24)}-${index}`,
        label: `Execute verified Mandate call ${index + 1}/${artifact.calls.length}`,
      }, () => true);
      const confirmed = circle.transactionHash
        ? circle
        : await this.wallet.waitForConfirmation(circle.transactionId);
      if (!confirmed.transactionHash || !confirmed.transactionId) {
        throw new Error("Circle did not bind a transaction ID to an Arc transaction hash");
      }
      const receipt = await verifyArcCallReceipt(
        confirmed.transactionHash,
        this.cfg.rpcUrl,
      );
      const executed = verifyMandateEvents(receipt, snap.mandate, inner);
      results.push({
        ...inner,
        status: "EXECUTED",
        circleTransactionId: confirmed.transactionId,
        tx: confirmed.transactionHash,
        artifactHash: artifact.artifactHash,
        requestHash: artifact.requestHash,
        navBefore: executed.args.navBefore.toString(),
        navAfter: executed.args.navAfter.toString(),
      });
      this.log(`  ✓ ${inner.label} EXECUTED ${this.cfg.explorer}/tx/${confirmed.transactionHash}`);
    }
    return { ok: true, results };
  }
}
