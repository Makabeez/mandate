import fs from "node:fs";
import path from "node:path";
import { decodeEventLog, encodeFunctionData, hexToString, keccak256, stringToHex, toBytes } from "viem";
import { ERC20_ABI, ERC4626_ABI, MANDATE_ABI } from "./chain.js";

const TAGS = { SWEEP_IN: "SWEEP_IN", SWEEP_OUT: "SWEEP_OUT", EXIT_ALL: "EXIT_ALL", HOLD: "HOLD", ALERT: "ALERT" };

/** Translate a policy action into the exact calls the mandate will execute. */
export function planCalls(cfg, snap, action) {
  const m = snap.mandate;
  const v = snap.venue?.address;
  switch (action.kind) {
    case "SWEEP_IN": {
      const deposit = { label: "deposit", target: v, data: encodeFunctionData({ abi: ERC4626_ABI, functionName: "deposit", args: [action.amount, m] }) };
      if ((snap.venue.allowance ?? 0n) >= action.amount) return [deposit];
      // the mandate allows approvals up to the venue cap: approve that once, not per deposit
      const amt = snap.venue.cap >= action.amount ? snap.venue.cap : action.amount;
      return [{ label: "approve", target: cfg.usdc, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [v, amt] }) }, deposit];
    }
    case "SWEEP_OUT":
      return [{ label: "withdraw", target: v, data: encodeFunctionData({ abi: ERC4626_ABI, functionName: "withdraw", args: [action.amount, m, m] }) }];
    case "EXIT_ALL":
      return [{ label: "redeem", target: v, data: encodeFunctionData({ abi: ERC4626_ABI, functionName: "redeem", args: [snap.venue.shares, m, m] }) }];
    default:
      return [];
  }
}

/** Decode the mandate's own events from a receipt. */
export function mandateEvents(receipt, mandate) {
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== mandate.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: MANDATE_ABI, data: log.data, topics: log.topics });
      out.push(ev);
    } catch {}
  }
  return out;
}

// common venue errors, by selector
const VENUE_ERRORS = {
  "0xace2a47e": "vault illiquid: TransferReverted() (market fully borrowed)",
  "0x4323a555": "vault illiquid: NotEnoughLiquidity()",
  "0xfe9cceec": "ERC4626ExceededMaxWithdraw",
  "0xb94abeec": "ERC4626ExceededMaxRedeem",
  "0x79012fb2": "ERC4626ExceededMaxDeposit",
  "0x4e487b71": "arithmetic panic in venue",
};

/** execute() returned false: ask the venue directly, from the mandate's address, why. */
async function venueReason(pub, mandate, call) {
  try {
    await pub.call({ account: mandate, to: call.target, data: call.data });
    return "execute() would return false although the venue call alone succeeds: a mandate limit would trip";
  } catch (e) {
    let hex = null;
    for (let d = e; d && !hex; d = d.cause) {
      if (typeof d.data === "string" && /^0x[0-9a-f]{8}/i.test(d.data)) hex = d.data;
      else if (typeof d.data?.data === "string") hex = d.data.data;
    }
    hex ||= (String(e.details || e.message).match(/0x[0-9a-fA-F]{8,}/) || [])[0] || null;
    const sel = hex ? hex.slice(0, 10).toLowerCase() : null;
    return `venue rejected the call: ${sel ? VENUE_ERRORS[sel] || `error ${sel}` : (e.shortMessage || "revert")}`;
  }
}

export const reasonText = (b32) => hexToString(b32, { size: 32 }).replace(/\0+$/, "");

/** Run Mandate's existing execute() simulation without sending a transaction. */
export async function preflightCall({ pub, account, snap, call, log }) {
  const base = {
    address: snap.mandate,
    abi: MANDATE_ABI,
    functionName: "execute",
    args: [call.target, call.data],
    account,
  };
  const sim = await pub.simulateContract(base).catch((e) => ({ error: e.shortMessage || e.message }));
  if (sim.error || sim.result !== true) {
    const detail = sim.error || (await venueReason(pub, snap.mandate, call));
    const result = { ...call, status: "PREFLIGHT_BLOCKED", detail };
    log(`  ✗ preflight blocked ${call.label}: ${detail}`);
    return { ok: false, result };
  }
  return { ok: true, base };
}

/**
 * Execute calls one by one. Each call is simulated first (eth_call of execute from the
 * agent address): if the mandate would return false, the transaction is never sent,
 * so the agent never trips its own breach wire.
 */
export async function runCalls({ pub, wallet, cfg, snap, calls, log }) {
  const results = [];
  for (const call of calls) {
    const preflight = await preflightCall({ pub, account: wallet.account, snap, call, log });
    if (!preflight.ok) return { ok: false, results: [...results, preflight.result] };
    const { base } = preflight;
    if (cfg.dryRun) {
      results.push({ ...call, status: "DRY_RUN" });
      log(`  ○ dry run: ${call.label} would pass preflight`);
      // later steps depend on this one having executed (e.g. deposit needs the approve)
      for (const rest of calls.slice(calls.indexOf(call) + 1)) {
        results.push({ ...rest, status: "DRY_RUN_NOT_SIMULATED" });
        log(`  ○ dry run: ${rest.label} not simulated (depends on ${call.label})`);
      }
      return { ok: true, results };
    }
    const hash = await wallet.writeContract(base);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const evs = mandateEvents(receipt, snap.mandate);
    const breach = evs.find((e) => e.eventName === "Breach");
    const exec = evs.find((e) => e.eventName === "Executed");
    const reverted = evs.find((e) => e.eventName === "CallReverted");
    const status = breach ? `BREACH:${reasonText(breach.args.reason)}` : exec ? "EXECUTED" : reverted ? "VENUE_REVERTED" : "UNKNOWN";
    results.push({
      ...call,
      status,
      tx: hash,
      navBefore: exec?.args.navBefore?.toString(),
      navAfter: exec?.args.navAfter?.toString(),
    });
    log(`  ${status === "EXECUTED" ? "✓" : "✗"} ${call.label} ${status} ${cfg.explorer}/tx/${hash}`);
    if (status !== "EXECUTED") return { ok: false, results };
  }
  return { ok: true, results };
}

const replacer = (_, v) => (typeof v === "bigint" ? v.toString() : v);

/** Persist a decision record; its keccak hash is what goes on-chain in note(). */
export function writeRecord(cfg, record) {
  const dir = path.join(cfg.dataDir, cfg.dryRun ? "decisions-dry" : "decisions");
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(record, replacer, 2);
  const hash = keccak256(toBytes(body));
  fs.writeFileSync(path.join(dir, `${hash}.json`), body);
  const idxFile = path.join(dir, "index.json");
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, "utf8")) : [];
  idx.push({ hash, mandate: record.mandate, at: record.at, tag: record.tag, kind: record.chosen?.kind, amount: record.chosen?.amount?.toString?.() ?? String(record.chosen?.amount ?? "0"), ok: record.execution?.ok ?? null });
  fs.writeFileSync(idxFile, JSON.stringify(idx.slice(-5000), null, 1));
  return { hash, uri: `${cfg.publicBase}/d/${hash}.json` };
}

export async function postNote({ pub, wallet, cfg, mandate, tag, hash, uri, log }) {
  if (cfg.dryRun) return null;
  const tx = await wallet.writeContract({
    address: mandate,
    abi: MANDATE_ABI,
    functionName: "note",
    args: [stringToHex(TAGS[tag] || tag, { size: 32 }), hash, uri],
  });
  await pub.waitForTransactionReceipt({ hash: tx });
  log(`  ✎ note ${tag} ${cfg.explorer}/tx/${tx}`);
  return tx;
}

export async function poke({ pub, wallet, cfg, mandate, log }) {
  if (cfg.dryRun) return null;
  const tx = await wallet.writeContract({ address: mandate, abi: MANDATE_ABI, functionName: "poke" });
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  const evs = mandateEvents(r, mandate);
  const froze = evs.find((e) => e.eventName === "Breach");
  log(`  ◦ poke${froze ? " → FROZE (" + reasonText(froze.args.reason) + ")" : ""} ${cfg.explorer}/tx/${tx}`);
  return tx;
}
