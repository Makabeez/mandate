import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AomiWidget, arc } from "@aomi-labs/widget";
import "@aomi-labs/widget/styles.css";

// ── configuration (edit for your deployment) ──
// The hosted Mandate app on Aomi: its name on the Aomi platform, or the numeric
// Application ID that Build shows once the app is active (aomi/mandate-agent/README.md).
// `?app=` and `?aomi=` override both for a staging check, the same way index.html
// takes `?api=` and `?rpc=`.
const CFG = {
  app: "mandate",
  aomi: "https://chat.aomi.dev",
};
{
  const q = new URLSearchParams(location.search);
  if (q.get("app")) CFG.app = q.get("app")!;
  if (q.get("aomi")) CFG.aomi = q.get("aomi")!;
}

const numericId = /^\d+$/.test(CFG.app) ? Number(CFG.app) : null;

function MandateAgent() {
  return (
    <AomiWidget
      applicationId={numericId ?? CFG.app}
      baseUrl={CFG.aomi}
      // Every turn goes to the Mandate app, never to Aomi's auto router.
      routing={{
        defaultMode: "direct",
        targets: [{ mode: "direct", apps: [numericId === null ? { app: CFG.app } : { applicationId: numericId, app: "mandate" }] }],
      }}
      // The dashboard's paper palette follows the OS; so does the chat.
      theme="system"
      width="100%"
      height="100%"
      showSidebar={false}
      // Mandate accounts live on Arc mainnet; the owner's EVM wallet is the only one that
      // matters here, so the network picker is pinned and hidden.
      walletFamilies={["evm"]}
      wallets={{ evm: { chains: [arc], appName: "Mandate" }, solana: false }}
      controlBarProps={{ hideNetwork: true, hideModel: true, hideAppSecrets: true }}
      // One app, one theme: the capability library and theme toggle would only add noise.
      features={{ library: false, theme: false }}
      persistThread
    />
  );
}

createRoot(document.getElementById("agent-root")!).render(
  <StrictMode>
    <MandateAgent />
  </StrictMode>,
);
