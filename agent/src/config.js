import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(here, "..");
export const REPO_DIR = path.resolve(AGENT_DIR, "..");

// minimal .env loader (no dependency); real env wins over the file
export function loadEnv(file = path.join(AGENT_DIR, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const usdc = (s, d) => BigInt(Math.round(Number(s ?? d) * 1e6));
const num = (s, d) => (s === undefined || s === "" ? d : Number(s));

export function config() {
  loadEnv();
  const e = process.env;
  const req = (k) => {
    if (!e[k]) throw new Error(`missing env ${k}`);
    return e[k];
  };
  const venues = (e.KNOWN_VENUES || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [address, ...name] = x.split(":");
      return { address: address.toLowerCase(), name: name.join(":") || address.slice(0, 10) };
    });
  const aomiEnabled = Boolean(e.AOMI_TASK_ENDPOINT);
  const chainId = num(e.CHAIN_ID, 5042);
  if (aomiEnabled && chainId !== 5042002) throw new Error("Aomi Execution Kit is Arc Testnet-only");
  return {
    rpcUrl: req("ARC_RPC_URL"),
    chainId,
    factory: req("FACTORY"),
    usdc: e.USDC || "0x3600000000000000000000000000000000000000",
    venues,
    signer: (e.AGENT_SIGNER || "local").toLowerCase(),
    keystore: expand(e.KEYSTORE),
    keystorePasswordFile: expand(e.KEYSTORE_PASSWORD_FILE),
    privateKey: e.AGENT_PRIVATE_KEY,
    // Circle Agent Wallet as the agent's signer (AGENT_SIGNER=circle); separate from Earn Kit below
    circleWallet: {
      address: e.CIRCLE_WALLET_ADDRESS,
      chain: e.CIRCLE_CHAIN || (num(e.CHAIN_ID, 5042) === 5042 ? "ARC" : ""),
      cli: e.CIRCLE_CLI || "circle",
    },
    llm: {
      baseUrl: e.LLM_BASE_URL || "",
      model: e.LLM_MODEL || "agent-loop",
      apiKey: e.LLM_API_KEY || "",
      timeoutMs: num(e.LLM_TIMEOUT_MS, 60_000),
      maxTokens: num(e.LLM_MAX_TOKENS, 4000),
    },
    publicBase: (e.PUBLIC_BASE_URL || `http://127.0.0.1:${num(e.PORT, 8095)}`).replace(/\/$/, ""),
    explorer: (e.EXPLORER_URL || "https://explorer.arc.io").replace(/\/$/, ""),
    port: num(e.PORT, 8095),
    host: e.HOST || "127.0.0.1",
    dataDir: path.resolve(AGENT_DIR, expand(e.DATA_DIR || "./data")),
    payablesFile: path.resolve(AGENT_DIR, expand(e.PAYABLES_FILE || "./payables.json")),
    cycleSeconds: num(e.CYCLE_SECONDS, 300),
    pokeMinutes: num(e.POKE_MINUTES, 1440),
    heartbeatHours: num(e.HEARTBEAT_HOURS, 24),
    riskCooldownHours: num(e.RISK_COOLDOWN_HOURS, 24),
    blockedBackoffMinutes: num(e.BLOCKED_BACKOFF_MINUTES, 60),
    indexFromBlock: BigInt(e.INDEX_FROM_BLOCK || "0"),
    dryRun: /^(1|true|yes)$/i.test(e.DRY_RUN || ""),
    aomi: {
      enabled: aomiEnabled,
      endpoint: e.AOMI_TASK_ENDPOINT || "",
      walletAddress: aomiEnabled ? req("CIRCLE_WALLET_ADDRESS").toLowerCase() : "",
      seller: aomiEnabled ? req("AOMI_TASK_SELLER").toLowerCase() : "",
      trustedJwksFile: aomiEnabled ? path.resolve(AGENT_DIR, expand(req("AOMI_TRUSTED_JWKS_FILE"))) : "",
      stateDirectory: path.resolve(AGENT_DIR, expand(e.AOMI_STATE_DIR || "./data/aomi")),
      maxFeeMicrousd: BigInt(e.AOMI_MAX_FEE_MICROUSDC || "1100000"),
      maxGasUnits: num(e.AOMI_MAX_GAS_UNITS, 1000000),
      circleCommand: e.CIRCLE_COMMAND || "circle",
    },
    // Circle Earn Kit: Circle's liquidity, APY and risk warnings per vault (Arc mainnet/testnet only)
    circle: {
      enabled: !/^(0|false|no|off)$/i.test(e.CIRCLE_EARN_KIT || ""),
      apiKey: e.CIRCLE_API_KEY || "",
      ttlMs: num(e.CIRCLE_REFRESH_MINUTES, 10) * 60_000,
      staleMs: num(e.CIRCLE_STALE_MINUTES, 60) * 60_000,
    },
    policy: {
      reserveFloor: usdc(e.RESERVE_FLOOR_USDC, 0.5),
      reserveBps: BigInt(num(e.RESERVE_BPS, 1000)),
      horizonHours: num(e.HORIZON_HOURS, 72),
      urgentHours: num(e.URGENT_HOURS, 24),
      payableBufferBps: BigInt(num(e.PAYABLE_BUFFER_BPS, 1000)),
      minMove: usdc(e.MIN_MOVE_USDC, 0.25),
      gasPerAction: usdc(e.GAS_PER_ACTION_USDC, 0.005),
      minBreakevenDays: num(e.MIN_BREAKEVEN_DAYS, 30),
      bandBps: BigInt(num(e.BAND_BPS, 500)),
      lossTripBps: BigInt(num(e.LOSS_TRIP_BPS, 5)),
      windDownHours: num(e.WIND_DOWN_HOURS, 24),
      // Circle Earn Kit warnings that stop new deposits into a vault (withdrawals are never blocked)
      circleBlock: (e.CIRCLE_BLOCK_WARNINGS ?? "low_liquidity,not_whitelisted").split(",").map((x) => x.trim()).filter(Boolean),
    },
  };
}
