# Web3 RPC Providers — stratégie et signups pour mm

Récap des discussions du 2026-04-15 sur les providers RPC à utiliser pour le projet **mm** (market-making / arbitrage multi-chain), et procédures d'inscription.

## Objectif

Avoir accès à des nodes Ethereum / Arbitrum / Base / Optimism / etc. pour :

- **Lire** : nouveaux blocks, tx mempool, events on-chain (swaps, liquidations), prices des pools, balances
- **Écrire** : `eth_call` de simulation, `eth_estimateGas`, `eth_sendRawTransaction`

Sans héberger notre propre node (coût disproportionné pour un usage personnel multi-chain).

## Architecture retenue : lecture / écriture séparées

```
┌─ TATUM (free) ──────────────────────────┐
│  WebSocket subscriptions                │
│  • Scanner multi-chain (blocks, swaps)  │
│  • Monitoring 5 wallets / pools         │
│  • Push events, 0 req/s HTTP consommées │
└──────────────┬──────────────────────────┘
               │ event détecté = opportunité
               ▼
        [ bot mm : logic + state ]
               │ re-read fresh + simuler + broadcast
               ▼
┌─ ALCHEMY (free, clé déjà en vault) ────┐
│  HTTP JSON-RPC                          │
│  • eth_call (simulation)                │
│  • eth_estimateGas                      │
│  • eth_sendRawTransaction               │
│  • 50+ chaînes avec 1 seule clé         │
└─────────────────────────────────────────┘
```

**Pourquoi cette séparation** :

- **Tatum subs = coût 0 en rate limit HTTP.** Le rate limit "3 req/s" de Tatum s'applique aux requêtes HTTP classiques, PAS aux events push via WebSocket. Tu peux monitorer 5 pools / chains en permanence sans grignoter ton quota.
- **Alchemy = gros pipe HTTP.** Les 4-6 requêtes faites par tx (simulate + estimate + broadcast) passent sans friction sur le free tier.
- **Redondance naturelle** : si un provider tombe, l'autre fonctionne encore.
- **Upgrade ciblé** : si un jour la capacité sature, on upgrade juste celui qui bloque (probablement Alchemy Growth 49 $ avant Tatum).

## Providers évalués

### Alchemy (écriture / simulations) — ✅ INSCRIT

- **Status** : clé API déjà sauvegardée dans OneCLI vault (`Alchemy`, type generic, host-pattern `*.g.alchemy.com`, header injecté `X-Alchemy-Token`)
- **Signup** : dashboard.alchemy.com/signup, email + password 15+ chars, **SMS requis** (tu as utilisé ton numéro perso)
- **Free tier** : 300M CU / mois (~100K req/jour), toutes les chaînes principales
- **Plan Growth 49 $/mois** : 1.5 B CU/mois + `trace_call` + WebSocket prioritaire + archive node (mais archive = non nécessaire pour mm)
- **Utilisation dans code** : soit mode URL `https://{network}.g.alchemy.com/v2/<key>`, soit mode header `X-Alchemy-Token` via OneCLI proxy
- **TOS** : comptes multiples interdits

### Tatum (lecture / scanning) — À INSCRIRE

- **Status** : pas encore inscrit (ou clé pas encore reçue)
- **Free tier** :
  - 3 req/s HTTP (limite globale tous endpoints confondus)
  - **5 WebSocket subscriptions actives** (événements push, hors rate limit)
  - Historique notifications : 24h
  - Full nodes (pas archive) + debugging tools
  - Community support uniquement
- **Interprétation importante** : les 5 subs ne sont PAS 5 chains × 3 req/s. C'est **5 subscriptions WebSocket totales** sur l'ensemble de ton compte. Les 3 req/s = cap sur les requêtes HTTP (non subscription).
- **Cap sur notifications reçues/jour** : à vérifier dans la doc (la mention "1-Day Notification History" suggère un quota).
- **Ce que chaque subscription peut surveiller** :
  - New blocks d'une chain
  - Tx impliquant une address
  - Events d'un contract (ex. tous les swaps d'un pool Uniswap)
  - Balance updates d'une address
- **Signup** : tatum.io, email + captcha (pas de SMS a priori)

### À évaluer en backup / alternative si on sature

| Provider | Free tier | Signup | Notes |
|----------|-----------|--------|-------|
| **Infura** | 100K req/jour, ~10 req/s | Email/MetaMask SIWE, Cloudflare Turnstile bloque `agent-browser` | Industrie standard. Détenu par ConsenSys (≈ MetaMask). |
| **Chainstack** | 3M req/mois, 30 req/s | Email + captcha | EU-hosted, faible latence vers Europe |
| **BlockPi** | 50M CU/mois, 100 req/s | Email | Très bon free tier, moins connu |
| **Ankr** | Public RPCs (~30 req/s, sans auth) + paid key | Email pour clé | 75+ chaînes, fallback utile |
| **QuickNode** | variable | Email + CC parfois | Solide global network |
| **GetBlock** | 40K req/jour | Email | 50+ chaînes, cap daily bas |
| **Moralis** | 40K CU/jour | Email | Indexation NFT/DeFi intégrée |
| **publicnode.com / llamarpc / cloudflare-eth** | Ouvert, pas de signup | Aucun | Ultime fallback pour dev |

## Signups : procédures et pièges

### Règle générale

- **Scanner les CGU** : la plupart interdisent les comptes multiples par personne. Sybil = risque de ban total + perte de tous les comptes du même "environnement" (IP, fingerprint, horaire, device).
- **Pas besoin d'ETH / de paiement** pour s'inscrire à un provider, même via "Sign-In With Wallet". La signature SIWE est off-chain.
- **SMS** : Alchemy exige SMS, Infura non (MetaMask SIWE ou email), Tatum/Chainstack/BlockPi/GetBlock acceptent email seul.
- **Captcha Cloudflare Turnstile** : détecte `agent-browser`. Nécessite intervention humaine pour cliquer le checkbox dans la fenêtre Chrome visible.

### Automation via agent-browser

`agent-browser` (CLI installé via `brew install agent-browser`) permet de piloter Chrome en local. OK pour Alchemy signup (testé), BLOQUE sur Turnstile Infura.

Commandes utiles :

```bash
agent-browser open <url>
agent-browser snapshot              # arbre accessibilité avec refs @e1, @e2...
agent-browser fill @e11 "valeur"
agent-browser click @e3
agent-browser screenshot /tmp/s.png
agent-browser eval "window.location.href"
```

### Email de verification : lecture via IMAP Zoho

Cloclo lit sa boîte `real.cloclo@zohomail.eu` via IMAP (channel déjà setup). Les emails de vérif providers arrivent :

- Soit dans **Boîte de réception**
- Soit dans **Notification** (dossier Zoho pour les automated emails — c'est là qu'est arrivé le mail Alchemy)
- Rarement **Spam**

Script one-shot pour extraire un lien de vérif :

```js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const client = new ImapFlow({
  host: 'imap.zoho.eu', port: 993, secure: true,
  auth: { user: 'real.cloclo@zohomail.eu', pass: '<app-password-from-vault>' },
  logger: false,
});
await client.connect();
for (const folder of ['INBOX', 'Notification']) {
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = await client.search({ since: new Date(Date.now() - 15*60*1000) });
    for (const uid of (uids || []).slice(-5)) {
      const msg = await client.fetchOne(uid, { envelope: true, source: true });
      const parsed = await simpleParser(msg.source);
      const hrefs = ((parsed.html || '').match(/href="([^"]+)"/g) || [])
        .map(h => h.slice(6, -1))
        .filter(h => /verify|confirm|token|ticket/i.test(h));
      if (hrefs.length) console.log(folder, msg.envelope.subject, hrefs);
    }
  } finally { lock.release(); }
}
await client.logout();
```

## Wallets cloclo — 5 adresses EVM générées

5 wallets créés localement avec `ethers.Wallet.createRandom()`, stockés chiffrés uniquement par permissions 0600 dans `store/wallets/cloclo-wallets.json` (gitignored).

Addresses publiques :

- `cloclo-1` : `0x061a91df19f295a1bC97F9ecc0329075a0BcEeFB`
- `cloclo-2` : `0xCf1C13A00BF5105d7eb8757C09d30C1959fE8D2B`
- `cloclo-3` : `0xAc6EDd269aA4978aF98cc8840eE95E522B672993`
- `cloclo-4` : `0x93cE183E9C3AB83d7b76Ad5D77E3f0d5B3B52a38`
- `cloclo-5` : `0x0D5fD531b84Ae9584473C86e83D7DC0f3bf172bE`

(Adresses identiques sur toutes les chaînes EVM : Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, etc.)

**À faire** : backup des seed phrases dans un password manager (1Password / Bitwarden) en plus du fichier local, sinon perte du fichier = perte des wallets.

**Bootstrap ETH** : non nécessaire pour signup SIWE (signature off-chain). Nécessaire uniquement quand on commencera à trader — envoyer ~0.01 ETH sur chaque wallet qui doit faire des tx.

## Latence et VPN

- **Providers majeurs** hébergés AWS us-east-1 (Virginia). Latence depuis Paris ≈ **80 ms** incompressible.
- **VPN** ajoute typiquement **+10 à +40 ms** selon l'exit.
- **Pour mm perso** : la latence provider n'est pas le bottleneck. Les vrais MEV competitors sont colo en Virginia. Inutile de s'en soucier avant que la stratégie génère déjà du profit.
- **VPN seulement utile pour les signups** (rotation d'IP pour éviter le rate-limiting du provider détectant plusieurs tentatives) — pas pour le runtime bot.

## Node perso AWS ? — non pour l'instant

| Approche | Coût/mois | Latence | Gestion |
|----------|-----------|---------|---------|
| Alchemy Growth | 49 $ | ~80 ms | 0 |
| Reth non-archive sur AWS `m7i.2xlarge` + 1.5 TB gp3 | ~350 $ | 1-5 ms (si même region que DEX) | Élevée |
| Reth archive sur `i4i.4xlarge` | ~1200 $ | 1-5 ms | Très élevée |
| Hetzner dédié (alternative) | 60-150 € | 20-50 ms | Élevée |

**Archive node = inutile pour mm**. Le full node non-archive a le state courant + history des tx, largement suffisant pour lire mempool, simuler au block courant, et broadcaster.

**Multi-chain** : un node perso par chain est économiquement absurde (8 chaînes × 600 $/mois). Les providers couvrent toutes les chains avec 1 clé.

**Décision** : rester provider-only tant que le bot ne génère pas au moins ~500 $/mois en profits. Au-delà, envisager Hetzner Reth sur Ethereum uniquement si la latence devient le bottleneck mesurable.

## Roadmap de signup pour mm

Ordre recommandé :

1. ✅ **Alchemy** — fait, clé dans OneCLI vault
2. **Tatum** — signup email, récupérer la clé, valider les 4 points d'incertitude (cap notifications/jour, filtres granularity, chains en WS, comportement en dépassement)
3. **BlockPi** ou **Chainstack** en backup HTTP si Alchemy atteint ses limites
4. **Ankr public RPCs** dans le code en fallback sans auth (juste l'URL)

## Utilisation dans le code mm

À implémenter : petit wrapper `mm/src/providers/` qui abstrait `read` / `write` :

```ts
const client = new MultiProvider({
  reads:  new TatumWebSocket({ apiKey, chains: ['ethereum', 'arbitrum', 'base'] }),
  writes: new AlchemyRpc({ apiKey, chain: 'arbitrum' }),
  fallback: [
    new BlockPiRpc({ apiKey }),
    new AnkrPublicRpc(),
  ],
});

client.onSwap(poolAddress, async (swap) => {
  if (isOpportunity(swap)) {
    // Re-read fresh state avant simulation
    const state = await client.read('getPoolState', poolAddress);
    const sim = await client.simulate(buildTx(state));
    if (sim.profitable) await client.sendTx(sim.tx);
  }
});
```

Avantages de cette abstraction :

- Change de provider sans toucher au code métier
- Retry automatique sur un autre provider en cas de 429 ou timeout
- Séparation read / write stable (perf + TOS propre)
- Testable (mock des providers en tests unitaires)

## Sources OneCLI

Les clés API stockées dans le vault (liste à jour) :

```bash
onecli secrets list
# → Alchemy (generic, *.g.alchemy.com, header X-Alchemy-Token)
# → Anthropic (anthropic, api.anthropic.com)
# + à venir : Tatum, BlockPi, Chainstack si signups faits
```

Pour lire une clé dans le code depuis le container :

- Mode **proxy automatique** : OneCLI injecte le header dans les requêtes sortantes matchant le host pattern. Code reste agnostique de la clé.
- Mode **explicit fetch** : `onecli secrets get Alchemy` si besoin d'accéder à la valeur directement (ex. pour construire l'URL path avec la clé comme le fait le SDK Alchemy officiel).

## Dates des discussions

- 2026-04-15 : setup initial, Alchemy inscrit, 5 wallets générés, exploration Tatum / Infura / GetBlock, décision architecture read/write split
