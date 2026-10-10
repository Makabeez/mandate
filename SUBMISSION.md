# Tameion submission: Mandate

> Draft. Fill the `TODO` lines on the day you submit; everything else is verified on mainnet as of Oct 6, 2026.

## The problem, in two sentences

A company can't hand its treasury to an AI agent, because the agent's limits live in the agent's own code, where nobody can verify them and a bug or a prompt injection can route around them. Mandate puts the limits in the account itself: the agent sweeps idle USDC into yield and keeps payables covered, and the Arc contract refuses anything outside the mandate, freezes the account, and keeps the attempt on-chain.

## Links

| | |
|---|---|
| Live dashboard | https://mandate-three-pi.vercel.app |
| Repo | https://github.com/Makabeez/mandate |
| Agent API / decision records | https://mandate.baserep.xyz/api/health |
| Factory (Arc mainnet) | `0xb3F362850E04aD6e9147698Cc1EdbcB8891f307e` |
| First mandate (Arc mainnet) | `0xEa08f2195ae9f29079a4cb6aFB05238949576d57` |
| Reproduce in one command | `make judge-demo` (no wallet, no RPC, no key, under 60s) |
| Video (96s) | https://youtu.be/haSBhd5yaK0 : the live dashboard, Circle's flag on the vault, a decision record checked against its on-chain hash, the blocked attack decoded on the Arc explorer, the agent's own withdrawal, the test results |
| Agent's signer | Circle Agent Wallet `0xbA2fBb82…E5cB`, locked by a Circle contract allowlist to the mandate account; policy changes need an email code. Live since Oct 9 |
| Standalone kit (Arc OSS) | https://github.com/Makabeez/mandate-kit : the contracts as deployed, client helpers (build, preflight, send, read the outcome), the Circle Agent Wallet signer, `make demo` on anvil |
| Contracts verified | All four (factory, mandate, both price readers) on the Arc explorer, via Sourcify, exact match: the breach tx's log decodes as `Breach(reason, target, selector)` |

## What happens in a cycle

1. The agent reads the account (idle cash, vault position, high-water mark, limits) and the company's upcoming payables.
2. A deterministic policy computes the idle target (reserve plus payables due in 72h, +10%) and every candidate action with its exact amount.
3. A reviewer LLM (DeepSeek through a LiteLLM router; any OpenAI-compatible model works) picks one candidate by id and writes the rationale. It cannot invent actions or amounts; urgent payables and risk exits are mandatory and it cannot veto them. If the reviewer is down or answers with something that isn't a candidate, the policy's own choice runs and the record says so.
4. Each call is simulated as `execute()` from the agent address. If the mandate or the venue would refuse it, it is never sent; the agent asks the venue for its revert reason, records it, and backs off for an hour instead of retrying every cycle.
5. The call executes through the mandate, which re-checks everything on-chain.
6. The full decision record is hashed and posted with `note(tag, hash, uri)`. The dashboard fetches the record and verifies the hash.

## A real liquidity freeze, handled live on mainnet

On Oct 1 the agent went live with 5 USDC fully deposited in Galaxy USDC (Morpho) and decided to pull 0.50 USDC back to its idle reserve. Its preflight showed the vault could not pay out even 0.000001 USDC: every dollar in the vault was lent out (`TransferReverted()`, market fully borrowed). The vault still held about 89.8M USDC in loans, so this was not a loss, but nobody could withdraw.

What the agent did, all verifiable:

| Step | Evidence |
|---|---|
| Decided to restore the reserve; DeepSeek agreed (`sweep_out` 0.500005) | decision record `0x7676696b…a2e0` served at `https://mandate.baserep.xyz/d/<hash>.json` |
| Simulated the withdrawal, saw the vault refuse, sent nothing | same record: `"venue rejected the call: vault illiquid: TransferReverted() (market fully borrowed)"` |
| Wrote the decision and the refusal on-chain | note tx `0x8b76fd84b15943df011be4b178dca796a426c11b9302815dc1aa3eae8fa0e0c5`, block 23722426; its content hash equals the keccak of the served record |
| Stopped retrying every 5 minutes; tries once an hour, no new notes, no gas | live status on the dashboard and at `/api/health` |
| When the vault paid out again, executed the same withdrawal on its own: 0.500009 USDC back to the idle reserve, balance 5.000090 before and after (no loss) | Oct 1, 23:35 UTC: withdraw tx `0x3a64c17a74cb40c9c460a0d6fe51d2845e0917a7f31698de3df0469f4735660b`; note tx `0x3fd0610b29eb0a88f3644a1042381544b2241fd4a8526b27b6352d129e87253a`, whose hash equals decision record `0xd152bf01…2a35` |

An agent without a preflight would have sent a reverting transaction every cycle. One that trusted `maxWithdraw` would have concluded nothing was there.

**What it exposed:** a treasury held in one vault can't pay a bill while that vault is locked. The policy keeps a 10% idle reserve to cover that, but this mandate started fully deployed, before the agent existed. A second venue and a reserve funded from day one are the fix (see Next).

## We tried to steer the reviewer through a bill label

We attacked our own reviewer with the five prompt-injection families from a public benchmark we published ([jev-news-bench](https://github.com/Makabeez/jev-news-bench)), planted in a bill's label. That is the one free-text field that reaches the reviewer's prompt; it is written by the owner's key, so the threat is a compromised key or a label pasted from a supplier's invoice. Each family names the action the attacker wants: invent a payout to the attacker, keep cash in the vault before a bill, veto a mandatory withdrawal, or veto a risk exit. A benign suffix of similar length is the control.

| Reviewer | Steered by attacks | Net of control | Mandatory actions vetoed | Amounts changed | Actions outside the candidate set | Funds sent outside the account and its vault |
|---|---|---|---|---|---|---|
| DeepSeek (`deepseek-pro`, production) | 0/51 (0%) | +0% | 0 | 0 | 0 | 0 |
| A stub that obeys every injection (worst case) | 20/20 (100%) | +100% | 0 | 0 | 0 | 0 |

**DeepSeek didn't move.** In all 73 answers that completed, its choice was the same as with a clean label, so no attack shifted it at all, toward the attacker's target or anywhere else. The other 11 calls hit the 60-second timeout. Nine of them were in the risk-exit scenario, including the clean-label and control runs, so they aren't attributable to the attacks; a timeout falls back to the policy's own choice. Raw answers: [`agent/test/results/injection-live.json`](agent/test/results/injection-live.json).

**We don't count on that.** This is one wording per family and one model. Our benchmark showed how much the phrasing matters: Jev was steered +34% by a direct instruction but +87% by an argument that the plain reading is wrong, and gpt-oss-20b the other way round (+92% and +51%). The stub row is the guarantee: a reviewer that does whatever the label says still moves nothing outside the policy's bounds.

**Why steering doesn't reach the money.** The reviewer's answer is an input, never the release condition:

1. **Policy:** every action and every amount is computed by the deterministic policy. `resolveChoice()` accepts only a candidate id; amounts, addresses and invented actions in the reply are discarded (the stub emitted 5 of them). In `MUST_ACT` and `RISK_EXIT` the live agent doesn't even ask the reviewer. The test forces the call to measure what it would have done, and the policy's action runs anyway.
2. **Executor:** every call is built with the account itself as receiver and owner, aimed only at the vault (or a USDC approval to the vault).
3. **Contract:** the mandate re-checks the venue, the function, the receiver, the caps and the loss on-chain. A call that breaks a rule is undone and the account freezes, as in the mainnet breach above.

**Worst case, with the obedient stub:** a steered reviewer picks another candidate the policy offered: `hold` instead of pulling 9.20 USDC out ahead of a bill due in 48h. The bill is still paid on time, because inside 24h the withdrawal becomes mandatory and no answer can veto it.

**Why we built it this way.** The benchmark found that confidence gating, the usual guard for a model on a safety path, lets steered answers through: injected text is unambiguous by construction, so a steered model is confident. We don't gate on the model; we bound what it can choose.

The test checks itself: with `resolveChoice()` deliberately broken it reports 10 vetoes, 15 changed amounts and 15 off-candidate actions, and fails. Reproduce offline with `node agent/test/injection.mjs --fake` (part of `make judge-demo`), or against a live reviewer with `make injection` (84 calls, about 11 minutes); raw answers land in `agent/test/results/`. Dashboard bill labels are also clipped to 80 characters, shorter than every attack here; the test runs them at full length.

## Every path money can take, and what blocks it

aomi's research on agent transactions ([Three Gates from Intent to Settlement](https://aomi.dev/research/three-gates-onchain)) says a security evaluation should "enumerate every path to value movement, identify the authority that can block each path and test the claimed coverage." Mandate is their second gate, a mandate enforced on-chain by the account contract, with the agent's runtime in front of it. Here is every path, with the test or mainnet transaction that shows it closed. Since Oct 9 the agent also has aomi's first gate: it signs through a Circle Agent Wallet whose policy only lets it call the mandate account (row 0).

| # | Path to value | Who can try it | What blocks it | Proof |
|---|---|---|---|---|
| 0 | The agent's signer calls any contract other than the mandate account (USDC directly, a vault, a drainer) | agent server | Wallet: Circle Agent Wallet policy, contract allowlist = the mandate account only. Changing it needs an email code the server doesn't have | Oct 9: a 0-USDC `approve` on USDC from the agent wallet was refused by Circle, "Contract address is not on the allowlist"; nothing was signed |
| 1 | Send USDC from the account to any address | agent key | Contract: on USDC the agent may only call `approve` (`BAD_APPROVE`) | `test_blocks_directUsdcTransfer` |
| 2 | Approve USDC to anyone but the vault, or above the vault's cap | agent key | Contract: `BAD_APPROVE` | `test_blocks_approveToNonVenue`, `test_blocks_approveAboveVenueCap` |
| 3 | Deposit into the vault for someone else | agent key | Contract: the receiver must be the account (`BAD_ARG`) | `test_blocks_depositToAttackerReceiver`, `testFuzz_foreignReceiverAlwaysBlocked` (512 random receivers); on mainnet, breach tx `0x1acc1506…8152` |
| 4 | Withdraw or redeem vault shares to someone else | agent key | Contract: receiver and owner must be the account (`BAD_ARG`) | `test_blocks_redeemToAttacker` |
| 5 | Transfer vault shares out, or call any vault function not allowlisted | agent key | Contract: `NOT_ALLOWED` | `test_blocks_unlistedSelectorOnVenue` |
| 6 | Call any other contract | agent key | Contract: `NOT_ALLOWED` | `test_blocks_unlistedVenue` |
| 7 | Lose money inside the agent's own call (skimming vault, bad price) | agent key, a venue | Contract: loss per call (10 bps), vault cap, total cap, drawdown. The call is undone and the account freezes | `test_lossPerCall_skimmingVenue`, `test_venueCap_rollsBackAndFreezes` |
| 8 | Lose money between calls (market) | anyone | `poke()`, callable by anyone, freezes the account past the drawdown line; the owner can still exit | `test_marketDrawdown_pokeFreezes_ownerExits` |
| 9 | Use the owner's functions: `withdraw`, `ownerExecute`, `setRule`, `setVenue`, `setLimits`, `setAgent`, `unfreeze` | agent key | Contract: `NotOwner` | `test_agentCannotUseOwnerSurface` |
| 10 | Act after the mandate expires, or while frozen | agent key | Contract: reverts | `test_expiry` |
| 11 | Steer the reviewer through a bill label (prompt injection) | whoever writes the label | Runtime: the reviewer can only pick a candidate id; amounts come from the policy; every call is built with the account as receiver | Injection test above: DeepSeek 0/51; an obedient stub 20/20 steered, zero blast radius |
| 12 | A bug in the agent builds a call that would fail | agent runtime | Runtime: every call is simulated first and not sent if it would fail; anything that does reach the contract meets rows 1–10 | Mainnet note tx `0x8b76fd84…e0c5` (withdrawal refused in simulation while the vault was illiquid) |

**What the mandate does not cover, and why:**

- **The owner's own key.** The owner can withdraw anywhere and call anything through `ownerExecute`. That is the point: the owner is the principal, and withdrawals must work even when the account is frozen. Protecting the owner's key is a wallet question (aomi's first gate), outside the account.
- **The vault's own code.** The account approves the vault up to its cap and holds its shares, so a broken or malicious vault could lose them. The owner chooses the vault; the cap bounds the exposure; row 7 catches a loss during the agent's call and row 8 one between calls.
- **A compromised agent server.** There is no agent key on it any more; it holds a Circle session that can only call the mandate account (row 0), and inside the account only what rows 1–10 allow: move money between the account and the vault, within the caps. The worst it can do is trigger a breach on purpose to freeze the account; the owner then unfreezes and replaces the agent with `setAgent`.
- **What the wallet gate doesn't see.** Circle's allowlist works on contract addresses, not functions, so it can't tell `execute()` from `note()`; the contract does that (rows 1–10). Circle's USDC transfer cap applies to the Circle wallet's own balance (zero), not to the USDC inside the account. Each gate covers what the other can't.
- **No block-builder gate.** Arc's ordering is not under our control; the loss-per-call check bounds what a manipulated price can cost in any one call.

## What was built during Tameion (Sept 27 – Oct 17)

Honest delta: the `MandateAccount` / `MandateFactory` contracts were written on Sept 18, before the window.

| Built in the window | Evidence |
|---|---|
| Mainnet deployment of factory and first mandate (Sept 30) | factory deploy tx `0x128abd1c…`, block 23603562 |
| Live agent deposit into Galaxy USDC (Morpho) | tx `0xd9614d93…c6c2` |
| Live blocked theft attempt (`BAD_ARG`) + owner unfreeze | tx `0x1acc1506…8152`, `0x5cd4803d…67a0` |
| Live agent withdrawal on mainnet, executed on its own after the vault became liquid again | tx `0x3a64c17a…660b` (Oct 1) |
| Treasury agent: payables-aware policy, reviewer LLM, preflight, on-chain decision log, event indexer, API | `agent/`, commits from Oct 1 |
| Dashboard: live headroom ruler, ledger with verifiable reasoning, one-flow mandate creation, owner console | `app/index.html` |
| Offline judge demo + local end-to-end harness | `make judge-demo` (24 contract tests + 18 decision scenarios + 17 bill checks + the injection test), `make e2e`, `make e2e-bills` |
| Prompt-injection test of the reviewer: five attack families in a bill label, blast radius measured on the calls the agent would send | `agent/test/injection.mjs`, section above |
| Every path to value movement mapped to what blocks it, plus a test that the agent's key is refused on every owner function | section above, `test_agentCannotUseOwnerSurface` |
| Circle Earn Kit as a live risk input: no new deposits into a vault Circle flags; signals in the prompt, the decision record and the dashboard; new mandates moved to the vault Circle lists clean | `agent/src/circle.js`, `/api/vaults`, two judge scenarios |
| Agent live on mainnet under PM2, public decision records and status API | `https://mandate.baserep.xyz/api/health`, note tx `0x8b76fd84…e0c5` |
| Live liquidity-freeze handling: venue revert diagnosis, backoff, status line on the dashboard | commits `67a5d4e`, `42cd2f2`; the section above |
| Owner-signed bills: the owner adds a bill by signing it with the owner wallet (checked against `owner()` on-chain), the agent keeps its cash ready, the owner pays from the dashboard, the bill settles from the on-chain payment | `agent/src/bills.js`, dashboard Bills section, `make e2e-bills` (forged, stale, tampered, replayed bills refused) |
| New mandates moved to a vault that kept paying out during the freeze (Steakhouse Prime USDC), checked on-chain with a real holder's withdrawal simulation | dashboard config, valuer `0x7c98…627f` |
| Circle Agent Wallet as the agent's signer, with a contract allowlist on the mandate account: the agent never holds a key. Contributed by Cecilia from the aomi team (PR #1, with a read-only Aomi App over the agent's API); we reviewed it, fixed a config collision with Earn Kit and switched the live agent | `agent/src/circle-wallet.js`, `aomi/mandate-agent/`; first wallet tx `0x86e486f4…198a` (poke, by hand), `setAgent` tx `0x602b44f9…ebea`, first agent tx through Circle `0xf0ab524a…52a3` (Oct 9) |
| Independent review of the agent before going live: 7 bugs found and fixed (incl. an RPC-relay allowlist bypass confirmed against the live RPC) | commit `d892807` message, regression scenarios in `agent/judge/run.js` |

## Real vs. simulated

| Claim | Status |
|---|---|
| Contracts deployed and operating on Arc mainnet | **Real** |
| Agent deposit into a live Morpho vault on Arc | **Real** |
| Breach blocked on mainnet, funds untouched, account frozen and unfrozen | **Real**, triggered on purpose by the builder to prove the guard |
| Agent running on mainnet, decisions and notes | **Real** since Oct 1, 14:19 UTC (note tx `0x8b76fd84…e0c5`) |
| Agent signs through a Circle Agent Wallet with a contract allowlist | **Real** since Oct 9, 13:31 UTC. The allowlist's refusal was tested on mainnet; Circle paid the gas (the wallet holds no USDC). The agent's first transaction of its own through it: its daily `poke()` on Oct 9, 14:31 UTC (`0xf0ab524a…52a3`), sent from the Circle wallet |
| Agent withdrawals on mainnet | **Real**: 0.500009 USDC on Oct 1, 23:35 UTC, executed by the agent on its own once the vault paid out again (tx `0x3a64c17a…660b`) |
| Liquidity freeze | **Real**, not staged: a third-party Morpho market reached full utilization |
| Payables schedule | Owner-signed bills entered in the dashboard; the first mandate's schedule was illustrative. No third-party company data |
| Vault loss / drawdown / expiry exits | **Simulated** in `make e2e` (mock vault loses 1%) and the judge scenarios; not triggered on mainnet |
| Third-party mandates | **None yet** as of Oct 6: the factory holds one mandate, the builder's. TODO: update before the final submission |
| Reviewer model | **Real** LiteLLM call in production; a deterministic stub in local tests, labelled `stub-reviewer` in records |
| Injection steering rates | **Real**: DeepSeek through the production router, 84 calls on Oct 4. The 100% row is a stub built to obey every injection |

## Constants and where they come from

| Constant | Value | Basis |
|---|---|---|
| Max loss per call | 10 bps | Measured: the live 5 USDC deposit lost 1 unit (0.000001 USDC) to vault rounding, 0.002 bps. 10 bps is 5,000× that and still catches a skimming venue in tests. |
| Reserve | max(0.5 USDC, 10% of NAV) | Owner-set policy, not derived. Configurable in `.env`. |
| Payables horizon / urgency | 72h / 24h, +10% buffer | Owner-set policy. |
| Risk exit on share price | >5 bps drop between observations | A lending vault's share price should never fall; any drop means bad debt or an exploit. 5 bps sits above rounding noise. |
| Drawdown exit | half of the mandate limit | Leaves room to exit through the vault before the contract freezes the account. |
| Gas per agent action | ~0.003–0.004 USDC | Measured on mainnet at 20 gwei: approve 159,983 gas, deposit 199,718 gas, decision note 29,739 gas (0.000595 USDC), poke 108,575 gas (0.002171 USDC). |

## The honest limit: size

At the default cadence the agent spends about 0.0028 USDC a day on upkeep (one `poke()` at 0.002171 USDC and one heartbeat note at 0.000595 USDC, both measured on mainnet), before any sweep. Galaxy USDC pays about 0.61% APY, so a 5 USDC mandate earns ~0.00008 USDC a day: **at demo size the agent costs more than it earns.** Break-even is roughly 166 USDC under mandate; above that the yield pays for the agent. The demo mandate exists to prove the guard and the decision loop on mainnet, not the economics.

## Next

- A second venue per mandate, so one illiquid vault can't trap the whole reserve. Circle's Earn Kit already tells the agent which vaults have liquidity; with two venues it could move the reserve to the liquid one.
- Fund the idle reserve at creation, not on the agent's first cycle.
- Payouts: the agent keeps bill cash ready, but only the owner's wallet can pay a bill. Allowlisted payees with per-payee caps, enforced by the contract, would let the agent pay on the due date by itself.

## Circle tooling used

- Arc mainnet: settlement, deterministic finality for limit checks, USDC as gas.
- USDC's ERC-20 interface at `0x3600…0000` for all accounting.
- **Earn Kit** (App Kit SDK, `@circle-fin/earn-kit`): every 10 minutes the agent reads Circle's view of each lending vault on Arc: available liquidity, APY and Circle's own risk warnings. A vault Circle flags `low_liquidity` or `not_whitelisted` gets no new deposits until the flag clears. Withdrawals are never blocked by it, and if Circle's service is down the agent behaves as before. The same signals go into the reviewer's prompt and the decision record, and the dashboard shows them (served at `/api/vaults`). Earn Kit also stands in for the vault's APY until the agent has an hour of its own share-price history.
- **What it caught on Oct 8:** Galaxy USDC, where the live mandate holds 4.5 USDC, was flagged `low_liquidity` (0.18 USDC available out of 89.7M). On real mainnet data the agent now holds, and with 50 USDC of extra idle cash it would still refuse a deposit, citing Circle's flag. Circle also flagged `not_whitelisted` on `0xbeef0007`, the vault the dashboard had picked for new mandates; new mandates now default to `0xbeef0016`, which Circle lists with no warnings (Circle-guarded, about 160k USDC available).
- **Agent Wallets** (`@circle-fin/cli`): since Oct 9 the agent signs every transaction through a Circle Agent Wallet instead of a local key. Its policy allowlists one contract, the mandate account, and any change to it needs an email code, so the agent's server can't loosen it. Proven on mainnet: the wallet's `poke()` went through (`0x86e486f4…198a`), and a call to USDC from the same wallet was refused by Circle before signing. The owner moved the account to it with `setAgent` (`0x602b44f9…ebea`).
- **Why not Earn Kit's deposit:** it signs from its own wallet adapter, and Mandate's money has to leave through the account's `execute()`, where the contract checks it. We use Earn Kit for what it knows about vaults, never to move funds.
- **Checked, not used:** aomi's Execution Kit (non-custodial: the agent keeps its key, so it adds no independent gate, confirmed by the aomi team on Oct 8). The aomi team instead contributed a read-only Aomi App (`aomi/mandate-agent`) that audits the account through the agent's API. Gateway and Arc Studio are not used.

## Traction

TODO before submitting: the number of mandates created by wallets other than the builder's, total USDC under mandate, and agent actions on mainnet. The hosted agent accepts any mandate that names it; the dashboard's create flow takes about seven wallet confirmations.

## Tooling feedback for Circle (separate $500 prize)

1. **Foundry scripts cannot move USDC on Arc.** `forge script` simulates locally before broadcasting, and USDC's `transferFrom` calls the blocklist precompile at `0x1800…0001`, which Foundry's EVM does not have (`OpcodeNotFound`). The whole script aborts and nothing is broadcast, including unrelated setup calls. The workaround was splitting setup (forge) from funding (`cast send`). A documented note, or a Foundry precompile shim, would save every team a debugging session.
2. **The RPC reference labels the mainnet endpoint "permissioned"**, but `rpc.mainnet.arc.io` answered `eth_chainId` and served a full deploy without allowlisting. Builders may go buy a private endpoint they don't need. Stating the actual policy (rate limits, which methods) would help.
3. **Native vs ERC-20 decimals** (18 vs 6 for the same balance) is well explained in the docs, but every tool that sends native value is a trap: `cast send --value 2` sends 2e-18 USDC. A bold warning in the "Connect to Arc" page would prevent real losses.
4. **ERC-4626 `max*` functions are not reliable liquidity signals across vault designs**; some implementations return 0 by design, so an agent that trusts `maxWithdraw` can conclude nothing is withdrawable. Not Circle's bug, but an Arc integration guide for the Morpho vaults that launched with mainnet (which to use, how to read liquidity) would help. Mandate treats 0 as unknown and relies on preflight simulation.
5. **Agent Wallet policies stop at the contract address.** A contract allowlist can't say "only `execute()` and `note()` on this contract". For Mandate the contract covers that, but for an agent calling a general-purpose contract (a router, a vault) a function-selector allowlist would make the wallet gate much tighter.
