<div align="center">

<img src="assets/banner.svg" alt="Mandate" width="100%"/>

### Give an AI agent a USDC budget and hard limits it cannot break.

[![Live Demo](https://img.shields.io/badge/Live_Demo-mandate--three--pi.vercel.app-22D3EE?style=for-the-badge)](https://mandate-three-pi.vercel.app)
[![Contract](https://img.shields.io/badge/Arc_Mainnet-Live-3B82F6-3B82F6?style=for-the-badge)](#deployment)
[![License](https://img.shields.io/badge/License-MIT-0B1020?style=for-the-badge)](LICENSE)
[![Built on Arc](https://img.shields.io/badge/Built_on-Arc-3B82F6?style=for-the-badge)](https://arc.io)

![Solidity](https://img.shields.io/badge/Solidity-0.8.30-363636?logo=solidity)
![Foundry](https://img.shields.io/badge/Foundry-tested-orange)
![Tests](https://img.shields.io/badge/tests-23%20%2B%2011%20scenarios-brightgreen)
![Morpho](https://img.shields.io/badge/venue-Morpho%20ERC--4626-2470FF)

</div>

> Agents that move money today run on *trust me*: the limits live in the agent's own code, where the owner can't verify them and the agent can route around them. Mandate moves the limits on-chain. The agent operates the account; the contract decides what it is allowed to do.

**Demo (96s):** https://youtu.be/haSBhd5yaK0 · **Live:** https://mandate-three-pi.vercel.app · **Judging guide:** [SUBMISSION.md](SUBMISSION.md)

## Try it

```bash
git clone https://github.com/Makabeez/mandate && cd mandate
make judge-demo     # no wallet, no RPC, no API key: 24 contract tests + 18 agent decision scenarios + 17 bill checks + a prompt-injection test
```

For the full loop on a local chain (real contracts, the real agent process, a stub reviewer): `cd agent && npm install && cd .. && make e2e`. For the owner's bill flow (sign a bill, the agent raises cash, the owner pays, the bill settles, forged and replayed bills refused): `make e2e-bills`.

## Why

Spending limits answer *"how much can the agent send?"* Mandate answers the question that matters for an agent that **manages** money: *"how much can it lose, where can the money go, and what happens when it tries something it shouldn't?"*

- **Outcome limits, not just spend limits:** max drawdown vs high-water mark, max loss inside a single call, per-venue and total exposure caps, expiry.
- **Argument-level guards:** the agent can call `deposit(amount, receiver)` on an allowlisted vault, but `receiver` must be the account itself. Enforced by a per-selector bitmask on ABI words.
- **Breaches leave evidence:** a violating call doesn't just revert. It is rolled back, the account freezes, and a `Breach(reason, target, selector)` event is persisted. Every attempt is public.
- **Non-custodial:** each mandate is its own contract owned by the user. The owner can always withdraw, even when the account is frozen or the mandate has expired. No pooled funds.

## Architecture

```
            owner (human)                          agent (AI)
                 │ deposit / withdraw / limits          │ execute(target, data)
                 ▼                                      ▼
        ┌──────────────────────── MandateAccount ─────────────────────────┐
        │ 1. pre-check   target is active venue? selector allowlisted?     │
        │                guarded args == self?  USDC approve ≤ venue cap?  │
        │        │ fail ──► Breach + freeze (tx succeeds, event persists)  │
        │        ▼                                                         │
        │ 2. try this.__run ── call venue ── post-check:                   │
        │        venue cap · deployed cap · loss-per-call · drawdown       │
        │        │ fail ──► whole call rolled back ──► Breach + freeze     │
        │        ▼                                                         │
        │ 3. Executed(navBefore, navAfter) · high-water mark updated       │
        └────────┬─────────────────────────────────────────────▲──────────┘
                 │ approve / deposit / redeem                   │ valueOf(account)
                 ▼                                              │
          Morpho USDC vault (ERC-4626) ───────────────── ERC4626Valuer

  poke()  ── permissionless NAV checkpoint; freezes on market drawdown
  note()  ── agent reasoning log: tag + content hash + URI
  MandateFactory ── deploys & indexes mandates (by owner, by agent) → leaderboard
```

## Treasury agent

`agent/` is the operator for one or many mandates: a cash sweep for a company treasury.

- **Keeps payables covered.** It reads upcoming payments (`payables.json`) and holds enough idle USDC to cover everything due in the next 72h plus 10%, never less than a 10% reserve. A shortfall inside 24h is mandatory: the reviewer cannot veto it.
- **Puts the rest to work** in the allowed ERC-4626 vault, within the venue cap and `maxDeployed`.
- **Exits on risk** before the contract has to freeze: vault share price down more than 5 bps, drawdown past half the limit, or less than 24h to mandate expiry.
- **The LLM reviews, it does not decide amounts.** The policy computes every candidate and amount; the reviewer (any OpenAI-compatible endpoint) picks one by id. An unknown choice is ignored and the policy default runs.
- **Never trips its own wire.** Every call is simulated as `execute()` from the agent address first; if the mandate would return false, the transaction is not sent.
- **Optional Circle signing boundary.** Replace the local key with a Circle Agent Wallet, then allowlist only the Mandate account. Policy changes require email OTP; Mandate still enforces the venue, receiver, loss, and deployment limits onchain.
- **Every decision is on-chain.** The full record (state, candidates, reviewer rationale, tx hashes) is hashed with keccak256 and posted via `note(tag, hash, uri)`. The dashboard re-hashes the served record and flags any mismatch.

Payouts to vendors stay owner-signed: the agent can only move cash between the account and the vault. That separation of duties is the point.

### Optional Aomi × Circle execution path

On Arc Testnet, the same deterministic policy can use a Circle Agent Wallet through Aomi's signature-only Task API. Mandate still chooses `planCalls`; the integration wraps them as exact ordered `MandateAccount.execute(target,data)` calls, asks Circle to sign the EIP-712 Task request, buys Aomi's simulated immutable artifact with a separate Gateway signature, and refuses to execute unless every returned byte equals the signed plan. Circle then signs the final calls. Completion requires Circle's transaction ID, a successful Arc receipt, the exact Mandate account/target/selector, one `Executed` event, and no `Breach` or `CallReverted` event.

Set `AOMI_TASK_ENDPOINT` plus the Circle wallet, trusted Aomi seller/JWKS, and switch `CHAIN_ID`/`ARC_RPC_URL` to Arc Testnet as documented in [`agent/.env.example`](agent/.env.example). Mainnet remains on Mandate's existing direct path until the Testnet acceptance record is complete.

Deploy (local key or Circle Agent Wallet): [`docs/DEPLOY.md`](docs/DEPLOY.md). Dashboard: [`app/index.html`](app/index.html), one static file.

### Aomi interface

`aomi/mandate-agent` is a deployable Aomi App for the running Mandate API. It gives a hosted agent typed, read-only tools for treasury status, bills, decisions, full decision records, and Arc events. Aomi explains and retrieves evidence; Mandate remains the decision and enforcement engine, and Circle remains the signer. See [`aomi/mandate-agent/README.md`](aomi/mandate-agent/README.md).

## Tech Stack

| Layer | Choice |
|---|---|
| Chain | Arc mainnet (chain 5042), USDC as gas |
| Contracts | Solidity 0.8.30, Foundry, zero external deps |
| Venue v0 | Morpho USDC vaults (ERC-4626) |
| Valuation | Pluggable `IValuer` per venue (`ERC4626Valuer`, `BalanceValuer`) |
| Agent | Node 20, viem, deterministic policy + OpenAI-compatible reviewer (LiteLLM) |
| UI | Single static page (`app/`), viem in the browser, wallet via EIP-1193 |

## Flow

1. Owner calls `MandateFactory.create(agent, limits)` and gets their own `MandateAccount`.
2. Owner allowlists a venue (`setVenue`) and its functions (`setRule`, with arg guards), then `deposit`s USDC.
3. Agent calls `execute(USDC, approve(vault, x))`, then `execute(vault, deposit(x, self))`.
4. Anyone can call `poke()` to checkpoint NAV; a drawdown past the limit freezes the account.
5. Owner can `withdraw`, `ownerExecute` (escape hatch), `freeze`/`unfreeze` at any time.

## Smart Contract

Policy check for a guarded argument (bit *i* ⇒ ABI word *i* must be the account):

```solidity
for (uint256 i; i < 8; ++i) {
    if (mask & (1 << i) == 0) continue;
    if (data.length < 4 + 32 * (i + 1)) return R_BAD_ARG;
    if (_word(data, i) != bytes32(uint256(uint160(address(this))))) return R_BAD_ARG;
}
```

Breach without reverting the agent's transaction: the call runs in a self-call, so post-checks can roll it back while the freeze and event persist:

```solidity
try this.__run(target, data) returns (uint256 navBefore, uint256 navAfter) {
    ...
} catch (bytes memory err) {
    bytes32 reason = _policyReason(err);
    if (reason != 0) _breach(reason, target, sel);   // freeze + Breach event
    else emit CallReverted(target, sel, err);         // venue error ≠ breach
    return false;
}
```

| Rule for a Morpho vault | Selector | `selfArgMask` |
|---|---|---|
| `deposit(assets, receiver)` | `0x6e553f65` | `0x02` |
| `withdraw(assets, receiver, owner)` | `0xb460af94` | `0x06` |
| `redeem(shares, receiver, owner)` | `0xba087652` | `0x06` |

## Local Dev

```bash
forge install foundry-rs/forge-std
forge test -vv          # 23 tests incl. fuzzing: in-policy never freezes, foreign receiver always blocked
```

## Deployment

```bash
cp .env.example .env && source .env
cast wallet import mandate-owner --interactive          # keystore, never a raw key in .env
forge script script/Deploy.s.sol --rpc-url arc --account mandate-owner --broadcast
FACTORY=0x... AGENT=0x... VAULT=0x... \
  forge script script/CreateMandate.s.sol --rpc-url arc --account mandate-owner --broadcast
```

Demo (96s): https://youtu.be/haSBhd5yaK0. All contracts below are verified on the Arc explorer (Sourcify, exact match).

| Contract | Arc mainnet |
|---|---|
| MandateFactory | `0xb3F362850E04aD6e9147698Cc1EdbcB8891f307e` |
| MandateAccount (first live mandate) | `0xEa08f2195ae9f29079a4cb6aFB05238949576d57` |
| ERC4626Valuer (Galaxy USDC) | `0xd4e895ACf808bB215b6DE8eC84F4b9f974fd0b61` |
| Venue: Galaxy USDC (Morpho) | `0x8E357432CC12ff425c36432F312968aEb16112AF` |
| Venue for new mandates: Steakhouse Prime USDC (Morpho) | `0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298` |
| ERC4626Valuer (that vault) | `0xdeCBf0E1E61F47651d10EC723750D727892FC960` |

New mandates use the Steakhouse Prime USDC vault that Circle's Earn Kit lists with no warnings (Circle-guarded, about 160k USDC available on Oct 8). Galaxy USDC was fully lent out on Oct 1 and again on Oct 8. An earlier choice, `0xbeef0007` (valuer `0x7c98…627f`), is flagged `not_whitelisted` by Circle and no mandate uses it.

### Circle's view of every vault

The agent reads Circle's Earn Kit (`@circle-fin/earn-kit`, App Kit SDK) for each vault on Arc: available liquidity, APY and Circle's own risk warnings. A vault Circle flags `low_liquidity` or `not_whitelisted` gets no new deposits until the flag clears; withdrawals are never blocked by it, and if Circle's service is down the agent behaves as before. The dashboard shows the same signals, served at `/api/vaults`. Earn Kit can also sign deposits, but only from its own wallet; Mandate's money has to leave through the account's `execute()`, where the contract checks it, so the agent uses Earn Kit for what it knows about vaults, never to move funds.

### Bills

The owner adds a bill (payee, amount, due date) by signing a plain-text message with the owner wallet; the agent's API checks the signature against `owner()` on-chain, so nobody else can add or remove one. Open bills feed the agent's payables: it keeps their cash idle and pulls it out of the vault when one is due within 24h. The owner pays from the dashboard (`withdraw(amount, payee)`, pulling any shortfall out of the vault first), and the bill settles itself when that payment appears on-chain. The agent never pays anyone: the contract only lets it move funds between the account and the vault.

### Live proof (Arc mainnet)

| Step | Signer | Result | Tx |
|---|---|---|---|
| Agent approves venue | agent | `Executed` NAV 5.000000 → 5.000000 | `0x3dced443f39bd54aba5bc04c3e92410be219a8cc47e5191f0aabfb423d636fdb` |
| Agent deposits 5 USDC into Galaxy USDC | agent | `Executed` NAV 5.000000 → 4.999999 (vault rounding) | `0xd9614d93a5497eb464e18ef14166e2744fc949dca409abbaa340d889ef68c6c2` |
| Agent tries to route shares to itself | agent | `Breach(BAD_ARG)` → frozen, NAV unchanged | `0x1acc1506cbff7b24277c30b198a36eef2c278286eb58acae3d031b6daea38152` |
| Owner reviews and unfreezes | owner | `Unfrozen` at NAV 5.000000 | `0x5cd4803de7d88bbf69f457a5a08c764c2bbaeacfe4be9dbf4b0b8c631b3c67a0` |

> The breach transaction succeeds on purpose: the violating call is rolled back, but the freeze and the `Breach` event persist. Every attempt to break the mandate stays on-chain.

## Security Notes

- Unaudited v0. Keep amounts small.
- Valuers are trusted and set by the owner only; a reverting valuer blocks `nav()`. Replace it via `setVenue`.
- Only allowlist deposit/withdraw/redeem-style functions. The loss-per-call check is defense in depth, not a license to allowlist arbitrary selectors.
- `ownerExecute` is unrestricted by design: it's the owner's account.

## License

MIT
