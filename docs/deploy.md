# CircuitMate — production deployment (VPS + reverse proxy)

Zero runtime dependencies (Node stdlib only). The app is a single ESM server in
`dist/src/server.js` serving `dist/public/`. This runbook assumes a Debian/Ubuntu
VPS with a domain, and installs Caddy as the primary TLS edge (Nginx fallback
included). No app code changes are required to deploy.

## Topology

```
browser ──https──▶ Caddy :443 ──◀─ proxy ──▶ circuitmate.service :127.0.0.1:3000
    │                                                     │
    └── wss://agents.assemblyai.com ◀──── direct WSS to AssemblyAI, never proxied
```

- The public edge owns 80/443; Node binds loopback only (`HOST=127.0.0.1`).
- `TRUST_PROXY=1` makes rate limiting key on `X-Forwarded-For`. Keep it **0**
  unless a trusted proxy is actually in front (see the warning in `.env.example`).
- Microphone access requires a **secure context** (HTTPS or localhost) — TLS is
  not optional for live voice input.

## 1. Install Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x — engines require >=18
```

## 2. Service user and directories

```bash
sudo useradd --system --create-home --home-dir /opt/circuitmate circuitmate
sudo mkdir -p /etc/circuitmate
sudo chown -R $USER: /opt/circuitmate
```

## 3. Ship the code

```bash
cd /opt/circuitmate
git clone <your-repo-url> .            # or rsync the project (including package-lock.json)
```

## 4. Build

```bash
cd /opt/circuitmate
npm ci
npm run build        # tsc + copy public/ → dist/public, wipes stale assets
```

## 5. Register the voice agent

Run once per host to create/refresh the AssemblyAI agent and write `AGENT_ID`:

```bash
npm run publish
```

Capture the resulting `AGENT_ID` and put it in `/etc/circuitmate/circuitmate.env`
(nothing else needs it at build time).

## 6. Secrets

```bash
sudo cp deploy/circuitmate.env.example /etc/circuitmate/circuitmate.env
sudo nano /etc/circuitmate/circuitmate.env   # fill ASSEMBLYAI_API_KEY, AGENT_ID
sudo chmod 600 /etc/circuitmate/circuitmate.env
```

Do **not** commit `.env`; the repo ignores it by design.

## 7. systemd service

```bash
sudo cp deploy/circuitmate.service /etc/systemd/system/circuitmate.service
sudo systemctl daemon-reload
sudo systemctl enable --now circuitmate
sudo systemctl status circuitmate   # should show "Listening" + (live voice)
```

`ProtectSystem=strict` makes the tree read-only for the service; that is fine —
the server never writes to disk.

## 8. Caddy (primary)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https ca-certificates curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # set your domain now
sudo systemctl enable --now caddy
```

Caddy provisions Let's Encrypt certs automatically and forwards
`X-Forwarded-For`/`X-Forwarded-Proto` for `TRUST_PROXY=1`.

## 9. Nginx fallback (only if not using Caddy)

```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/circuitmate
sudo ln -s /etc/nginx/sites-available/circuitmate /etc/nginx/sites-enabled/
sudo ${EDITOR:-nano} /etc/nginx/sites-available/circuitmate   # set your domain
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d circuitmate.example.com
```

## 10. Firewall

Open only the edge ports; never expose 3000.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 11. End-to-end verification

```bash
curl -s https://<domain>/api/health                     # {"ok":true,"mock":false,...}
curl -s https://<domain>/api/config                     # {"agentId":"…","mock":false,…}
curl -s https://<domain>/api/voice-token                # {"token":"AQI…"} (short-lived)
curl -s -I https://<domain>/                            # 200, CSP + HSTS headers present
```

Then open the site in a browser (HTTPS) and exercise a full voice round-trip:
talk → see the scope trace rise → transcript rows appear → agent speaks back.

## 12. Updating

```bash
cd /opt/circuitmate
git pull
npm ci && npm run build
sudo systemctl restart circuitmate
```

Then re-run `npm run publish` if the agent config changed.