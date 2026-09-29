import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { useEffect, useState } from "react";
import type { StudioInput } from "./studio";

const CONNECT = "standard:connect";
const SIGN = "solana:signTransaction";
const CHAIN = "solana:mainnet";

function useSolanaWallets() {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  useEffect(() => {
    const api = getWallets();
    const update = () =>
      setWallets(api.get().filter((w) => CONNECT in w.features && SIGN in w.features && w.chains.some((c) => c.startsWith("solana:"))));
    update();
    const offs = [api.on("register", update), api.on("unregister", update)];
    return () => offs.forEach((off) => off());
  }, []);
  return wallets;
}

const toBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

// Server builds + partially signs (new account keypair), wallet signs as fee payer, server submits.
async function signAndSend(wallet: Wallet, account: WalletAccount, txBase64: string) {
  const sign = (wallet.features[SIGN] as any).signTransaction;
  const [{ signedTransaction }] = await sign({ account, transaction: toBytes(txBase64), chain: CHAIN });
  const { signature } = await post("/api/tx/send", { tx: toBase64(signedTransaction) });
  return signature as string;
}

export function DeployPanel({ input, valid }: { input: StudioInput; valid: boolean }) {
  const wallets = useSolanaWallets();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ address: string; sig: string } | null>(null);
  const [launched, setLaunched] = useState<{ mint: string; sig: string } | null>(null);
  const [token, setToken] = useState({ name: "", symbol: "", image: "" });

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = (w: Wallet) =>
    run("Connecting", async () => {
      const { accounts } = await (w.features[CONNECT] as any).connect();
      setWallet(w);
      setAccount(accounts[0]);
    });

  const deploy = () =>
    run("Deploying config", async () => {
      const { tx, config: address } = await post("/api/studio/deploy", { input, wallet: account!.address });
      setConfig({ address, sig: await signAndSend(wallet!, account!, tx) });
    });

  const launch = () =>
    run("Launching token", async () => {
      const { tx, mint } = await post("/api/studio/launch", { config: config!.address, wallet: account!.address, ...token });
      setLaunched({ mint, sig: await signAndSend(wallet!, account!, tx) });
    });

  return (
    <section className="card">
      <h2>Deploy to mainnet</h2>
      <p className="caption">Deploy these parameters as a DBC config you own (you become fee claimer, so partner fees on its pools are yours), then launch tokens on it.</p>
      {!account ? (
        wallets.length ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {wallets.map((w) => (
              <button key={w.name} className="btn ghost" onClick={() => connect(w)} disabled={!!busy}>
                <img src={w.icon} alt="" width={16} height={16} style={{ verticalAlign: "middle", marginRight: 6 }} />
                {w.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">No Solana wallet detected. Install Phantom, Solflare or Backpack to deploy.</p>
        )
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="muted">Connected <span className="mono">{account.address}</span></div>
          {!config ? (
            <button className="btn" onClick={deploy} disabled={!valid || !!busy}>Deploy config (about 0.01 SOL rent)</button>
          ) : (
            <div>
              Config <a className="mono" href={`https://solscan.io/account/${config.address}`} target="_blank" rel="noreferrer">{config.address}</a> is live.
            </div>
          )}
          {config && !launched && (
            <div style={{ display: "grid", gap: 8 }}>
              <input placeholder="Token name" value={token.name} onChange={(e) => setToken({ ...token, name: e.target.value })} />
              <input placeholder="Symbol" value={token.symbol} onChange={(e) => setToken({ ...token, symbol: e.target.value.toUpperCase() })} />
              <input placeholder="Image URL (optional)" value={token.image} onChange={(e) => setToken({ ...token, image: e.target.value })} />
              <button className="btn" onClick={launch} disabled={!token.name || !token.symbol || !!busy}>Launch token on this config</button>
            </div>
          )}
          {launched && (
            <div>
              Token launched: <a className="mono" href={`https://jup.ag/tokens/${launched.mint}`} target="_blank" rel="noreferrer">{launched.mint}</a>
            </div>
          )}
        </div>
      )}
      {busy && <p className="muted">{busy}…</p>}
      {error && <p className="warn">{error}</p>}
    </section>
  );
}
