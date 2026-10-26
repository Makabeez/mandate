# Deploying the treasury agent and the dashboard

Everything below runs on the home VPS (WSL, PM2) from `/mnt/c/Github/mandate`.

## 1. Agent

### Circle Agent Wallet (recommended)

Circle becomes the independent signing boundary: the agent process can request calls but never
receives or stores a private key. Install the CLI, authenticate on mainnet, and copy the Arc wallet
address into `agent/.env`:

```bash
npm install -g @circle-fin/cli
circle wallet login you@example.com
circle wallet list --chain ARC --type agent --output json

# agent/.env
AGENT_SIGNER=circle
CIRCLE_WALLET_ADDRESS=0xYourCircleAgentWallet
CIRCLE_CHAIN=ARC
```

The Mandate owner must then call `setAgent(0xYourCircleAgentWallet)` on each existing account (or
use this address when creating a new account). Confirm that rotation onchain before starting the
process; the agent deliberately ignores accounts whose `agent()` no longer matches its signer.

On Arc mainnet, bind the Circle wallet to the Mandate account. This policy change requires a
separate email OTP, so the unattended agent cannot silently relax it:

```bash
circle wallet limit set \
  --address 0xYourCircleAgentWallet \
  --chain ARC \
  --policy-type contract \
  --rule-type contract-allowlist \
  --targets "[0xYourMandateAccount]"

circle wallet limit --address 0xYourCircleAgentWallet --chain ARC --output json
```

The Circle policy allowlists contract addresses, not individual function selectors. That is enough
for this design because the Circle wallet is the Mandate `agent`, not its owner: `MandateAccount`
only lets that address use `execute()` and `note()` (while `poke()` is permissionless), and
`execute()` applies the venue, selector, receiver, deployment, and loss rules onchain.

Circle's stablecoin transfer caps apply to USDC held by the Circle wallet. They do **not** cap USDC
held inside `MandateAccount`, because these calls send zero value and operate the account's funds.
Keep the financial caps in the Mandate contract; use Circle's contract allowlist to prevent the
signer from calling anything else.

For Arc testnet, use a testnet Circle session and `CIRCLE_CHAIN=ARC-TESTNET`. Circle spending
policies are mainnet-only, so testnet proves the signing integration but not the independent policy
gate.

### Local keystore

```bash
cd /mnt/c/Github/mandate && git pull
cd agent && npm install
cp .env.example .env            # defaults already point at the live factory, Galaxy USDC and explorer
cp payables.example.json payables.json   # edit: real upcoming payments for the mandate

# keystore password, never typed on the command line
read -rsp "mandate-agent keystore password: " PW && printf '%s' "$PW" > ~/.mandate-agent.pass && unset PW && chmod 600 ~/.mandate-agent.pass

# dry run first: reads chain, asks the reviewer, preflights, sends nothing
DRY_RUN=true node src/index.js --once
```

Read the dry-run line for the live mandate. With 5 USDC fully deployed and no payables, expect a
discretionary `sweep_out` of 0.50 USDC (restoring the 10% idle reserve). Then go live:

```bash
node src/index.js --once        # one real cycle: action, note(), poke()
pm2 start ecosystem.config.cjs && pm2 save
pm2 logs mandate-agent --lines 30
```

`LLM_BASE_URL` points at the LiteLLM router (`agent-loop` alias). If the router has a master key,
set `LLM_API_KEY`. With no reviewer reachable, the agent falls back to the policy's primary choice
and says so in the decision record.

## 2. Public API (decision records linked from on-chain notes)

The agent serves `/api/*`, `/d/<hash>.json` and a read-only RPC relay on `127.0.0.1:8095`.
Expose it through the existing Baserep tunnel:

```bash
CFG=/home/vps/.cloudflared/baserep-config.yml
cp $CFG $CFG.bak.$(date +%s)
grep -c "mandate.baserep.xyz" $CFG || python3 - "$CFG" <<'EOF'
import sys; p=sys.argv[1]; s=open(p).read()
entry = "  - hostname: mandate.baserep.xyz\n    service: http://127.0.0.1:8095\n"
i = s.rfind("  - service: http_status:404")
assert i > 0, "catch-all rule not found"
open(p, "w").write(s[:i] + entry + s[i:]); print("ingress added")
EOF
cloudflared tunnel list                                   # copy the full ID of the Baserep tunnel (starts f65acfa8)
cloudflared tunnel route dns <full-tunnel-id> mandate.baserep.xyz
pm2 restart baserep-tunnel && sleep 5
curl -s https://mandate.baserep.xyz/api/health
```

`127.0.0.1`, not `localhost`: Node resolves `localhost` to `::1` first.

## 3. Dashboard

Two pages in `app/`: the accounts dashboard `index.html` (no bundled code; it imports viem from
a CDN) and `agent.html`, which embeds the hosted Mandate Treasury Agent through the Aomi widget.
The widget is a React component, so the folder is a small Vite project and the deploy is a build:

```bash
cd /mnt/c/Github/mandate/app && npm install && npm run build   # writes dist/
npx vercel deploy --prod                                        # app/vercel.json builds the same way
```

`app/vercel.json` sets the build command and output directory, so a Vercel project whose root is
`app/` keeps working; a project that served `app/` as plain static files needs that one setting.

The dashboard reads Arc directly and falls back to the agent's `/rpc` relay if the browser can't
reach the RPC. For a local check against anvil: `?rpc=…&chain=31337&factory=…&featured=…&api=…`.

The agent page talks to `https://chat.aomi.dev` and pins every turn to the `mandate` App that
[aomi/mandate-agent/README.md](../aomi/mandate-agent/README.md) deploys. `?app=<Application ID>`
and `?aomi=<origin>` point it at another release or at staging. It is read-only by construction:
the App exposes only the five read tools, and the widget's wallet connection is used for identity
and for whatever the owner chooses to sign in the dashboard, never by the agent.
