#!/usr/bin/env node
// Mandate treasury agent: keeps payables covered, sweeps idle USDC into yield,
// and records every decision on-chain next to the mandate's own breach log.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { clients, loadAccount, FACTORY_ABI, MANDATE_ABI } from "./chain.js";
import { decide, resolveChoice, fmt } from "./policy.js";
import { review } from "./llm.js";
import { snapshot } from "./snapshot.js";
import { planCalls, runCalls, writeRecord, postNote, poke } from "./executor.js";
import { Indexer } from "./indexer.js";
import { startServer } from "./server.js";
import { Bills } from "./bills.js";
import { CircleVaults } from "./circle.js";
import { AomiMandateExecutor } from "./aomi.js";

const cfg = config();
const log = (...a) => console.log(new Date().toISOString(), ...a);
fs.mkdirSync(cfg.dataDir, { recursive: true });

const stateFile = path.join(cfg.dataDir, "state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
state.sharePrice ||= {};
state.lastPoke ||= {};
state.lastHeartbeat ||= {};
state.cooldownUntil ||= {};
state.blocked ||= {};
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

let lastGoodPayables = {};
const readPayables = () => {
  if (!fs.existsSync(cfg.payablesFile)) return (lastGoodPayables = {});
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.payablesFile, "utf8"));
    lastGoodPayables = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  } catch (e) {
    log(`payables file unreadable (${e.message}); keeping the last good copy`);
  }
  return lastGoodPayables;
};

const account = cfg.aomi.enabled ? { address: cfg.aomi.walletAddress } : await loadAccount(cfg);
const { pub, wallet } = clients(cfg, cfg.aomi.enabled ? null : account);
const aomi = cfg.aomi.enabled ? new AomiMandateExecutor({ cfg, pub, log }) : null;
const indexer = new Indexer({ pub, cfg, log });
const known = (a) => indexer.db.mandates.some((x) => x.toLowerCase() === a.toLowerCase());
// a bill can only be stored for an account our factory created (re-index once for a brand-new one)
const circle = new CircleVaults({ cfg, log });
const bills = new Bills({ cfg, pub, isMandate: async (a) => known(a) || (await indexer.sync().catch(() => {}), known(a)) });
const status = { agent: account.address, dryRun: cfg.dryRun, lastCycle: null, mandates: {} };

log(`agent ${account.address} | factory ${cfg.factory} | venues ${cfg.venues.map((v) => v.name).join(", ") || "none"} | ${cfg.dryRun ? "DRY RUN" : aomi ? "AOMI + CIRCLE" : "LIVE"}`);
const once = process.argv.includes("--once");
if (!once) startServer({ cfg, indexer, bills, circle, getStatus: () => ({ ...status, circle: { enabled: circle.enabled, asOf: circle.at ? new Date(circle.at).toISOString() : null, error: circle.error } }), log }); // a one-shot cycle needs no API

async function cycleMandate(mandate) {
  // operator-configured payables plus the owner's own signed bills that are still unpaid
  const payables = { ...readPayables() };
  const key0 = mandate.toLowerCase();
  payables[key0] = [...(payables[key0] || []), ...bills.payables(mandate, indexer.eventsFor(mandate))];
  const snap = await snapshot({ pub, cfg, state, mandate, payables, circle });
  if (snap.agent.toLowerCase() !== account.address.toLowerCase()) return; // owner rotated the agent
  const decision = decide(snap, cfg.policy);
  const v = snap.venue;
  log(`[${mandate.slice(0, 10)}] nav ${fmt(decision.facts.nav ?? snap.idle)} idle ${fmt(snap.idle)} deployed ${fmt(v?.value ?? 0n)} → ${decision.mode}: ${decision.candidates.map((c) => `${c.id}(${fmt(c.amount)})`).join(" | ")}`);

  const key = mandate.toLowerCase();
  const blk = state.blocked[key];
  const baseStatus = { at: snap.now, mode: decision.mode, nav: String(decision.facts.nav ?? snap.idle), idle: String(snap.idle), deployed: String(v?.value ?? 0n), frozen: snap.frozen };
  // same action still blocked: skip the reviewer and the retry until the backoff ends
  if (blk && snap.now < blk.until && decision.primary.kind === blk.kind) {
    log(`  backing off: last ${blk.kind} was blocked (${blk.reason || blk.detail}); retry after ${new Date(blk.until * 1000).toISOString()}`);
    status.mandates[mandate] = { ...baseStatus, chosen: null, blocked: blk.reason || blk.detail, backoffUntil: new Date(blk.until * 1000).toISOString() };
    return;
  }

  const rev = await review(cfg, snap, decision);
  const { chosen, overridden, reason } = resolveChoice(decision, rev);
  if (rev?.error) log(`  reviewer unavailable: ${rev.error} → policy default`);
  else if (rev) log(`  reviewer(${rev.model}) chose ${rev.choice}${overridden ? " (rejected)" : ""}: ${rev.rationale}`);

  const now = snap.now;
  const isAction = ["SWEEP_IN", "SWEEP_OUT", "EXIT_ALL"].includes(chosen.kind);
  const lastHb = state.lastHeartbeat[mandate] || 0;
  const heartbeatDue = now - lastHb >= cfg.heartbeatHours * 3600;
  const alertNew = chosen.kind === "ALERT" && state.lastAlert?.[mandate] !== chosen.why;

  let execution = null;
  let blockedRepeat = false;
  if (isAction) {
    const calls = planCalls(cfg, snap, chosen);
    execution = aomi
      ? await aomi.run({ snap, calls })
      : await runCalls({ pub, wallet, cfg, snap, calls, log });
    if (!execution.ok && !cfg.dryRun) {
      const last = execution.results.at(-1);
      blockedRepeat = blk?.kind === chosen.kind && (blk?.status ?? blk?.detail) === last?.status;
      state.blocked[key] = { kind: chosen.kind, status: last?.status, reason: last?.detail || last?.status, until: now + cfg.blockedBackoffMinutes * 60 };
    } else if (execution.ok) delete state.blocked[key];
    if (execution.ok && chosen.kind === "EXIT_ALL" && decision.mode === "RISK_EXIT" && !cfg.dryRun)
      state.cooldownUntil[key] = now + cfg.riskCooldownHours * 3600;
  }

  status.mandates[mandate] = { ...baseStatus, chosen: chosen.id, ...(execution && !execution.ok ? { blocked: execution.results.at(-1)?.detail || execution.results.at(-1)?.status } : {}) };

  if ((isAction && !blockedRepeat) || heartbeatDue || alertNew) {
    const record = {
      v: 1,
      mandate,
      at: new Date(now * 1000).toISOString(),
      block: snap.block,
      tag: chosen.kind,
      state: {
        nav: decision.facts.nav, idle: snap.idle, deployed: v?.value ?? 0n, hwm: snap.hwm, frozen: snap.frozen,
        target: decision.facts.target, band: decision.facts.band, dueHorizon: decision.facts.dueHorizon, dueUrgent: decision.facts.dueUrgent,
        venue: v ? { address: v.address, name: v.name, cap: v.cap, apyBps: v.apyBps, apySource: v.apySource, sharePriceDropBps: v.sharePriceDropBps, circle: v.circle } : null,
        payables: snap.payables,
      },
      mode: decision.mode,
      candidates: decision.candidates,
      chosen,
      review: rev ? { model: rev.model, choice: rev.choice, rationale: rev.rationale, riskFlags: rev.riskFlags, error: rev.error, accepted: !overridden, resolution: reason } : { resolution: "policy_only" },
      execution,
      policy: cfg.policy,
    };
    const { hash, uri } = writeRecord(cfg, record);
    try {
      if (aomi) log(`  Aomi mode: decision record saved locally at ${uri}; note execution is not part of the verified action artifact`);
      else await postNote({ pub, wallet, cfg, mandate, tag: chosen.kind, hash, uri, log });
    } catch (e) {
      log(`  note failed: ${e.shortMessage || e.message}`);
    }
    if (!cfg.dryRun) {
      state.lastHeartbeat[mandate] = now;
      if (chosen.kind === "ALERT") (state.lastAlert ||= {})[mandate] = chosen.why;
    } else log(`  (dry run) record ${uri}`);
  }

  if (!aomi && !snap.frozen && now - (state.lastPoke[mandate] || 0) >= cfg.pokeMinutes * 60) {
    try {
      if (await poke({ pub, wallet, cfg, mandate, log })) state.lastPoke[mandate] = now;
    } catch (e) {
      log(`  poke failed: ${e.shortMessage || e.message}`);
    }
  }
}

async function cycle() {
  await circle.refresh(); // never throws; stale or missing data just means "no opinion"
  try {
    await indexer.sync();
  } catch (e) {
    log(`indexer: ${e.shortMessage || e.message}`);
  }
  // Discover by current agent(), not factory.mandatesRunBy: that index is written once at
  // creation, so a mandate whose owner later called setAgent(us) would be missed.
  let run = [];
  try {
    const all = indexer.db.mandates.length ? indexer.db.mandates : await indexer.mandates();
    for (const m of all) {
      const a = await pub.readContract({ address: m, abi: MANDATE_ABI, functionName: "agent" });
      if (a.toLowerCase() === account.address.toLowerCase()) run.push(m);
    }
  } catch (e) {
    log(`discovery failed: ${e.shortMessage || e.message}`);
  }
  for (const m of run) {
    try {
      await cycleMandate(m);
    } catch (e) {
      log(`[${m.slice(0, 10)}] error: ${e.shortMessage || e.message}`);
    }
  }
  status.lastCycle = new Date().toISOString();
  saveState();
}

await cycle();
if (once) process.exit(0);
// chain cycles instead of setInterval: a slow cycle (receipts, reviewer) must never overlap the next
const loop = () => setTimeout(async () => { await cycle(); loop(); }, cfg.cycleSeconds * 1000);
loop();
