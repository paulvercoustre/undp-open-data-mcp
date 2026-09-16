# Hosting the HTTP variant

The stdio server (`dist/index.js`) is what local clients run. This covers the HTTP
variant (`dist/http-server.js`), which exists so the server can be hosted and added to
claude.ai as a **remote custom connector** — the only way to reach it from the web app or
from Claude on mobile.

## What claude.ai requires

- A **public HTTPS URL**. The connection comes from Anthropic's servers, not from the
  user's laptop, so anything behind a VPN or an internal-only firewall will not work.
- On **Team/Enterprise plans only an Owner can add a connector** (Organization Settings →
  Connectors). On Pro/Max an individual adds it themselves under Settings → Connectors.

The MCP endpoint is `POST /mcp`, so the connector URL is `https://your-host/mcp`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mcp` | MCP over Streamable HTTP. Rate limited. |
| `GET` | `/health` | Liveness probe. Deliberately *not* rate limited, so load balancers can poll it. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `RATE_LIMIT` | `120` | Requests per IP per window on `/mcp`. |
| `RATE_WINDOW_MS` | `60000` | Rate limit window. |
| `UNDP_CACHE_TTL_MS` | `3600000` | Upstream cache lifetime. |

## On a VM (systemd + Caddy)

```bash
git clone https://github.com/paulvercoustre/undp-open-data-mcp.git
cd undp-open-data-mcp
npm ci && npm run build
```

`/etc/systemd/system/undp-mcp.service`:

```ini
[Unit]
Description=UNDP Open Data MCP server
After=network.target

[Service]
Type=simple
User=undp-mcp
WorkingDirectory=/opt/undp-open-data-mcp
Environment=NODE_ENV=production PORT=3000
ExecStart=/usr/bin/node dist/http-server.js
Restart=always
RestartSec=5
# The server writes nothing and needs no host access.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now undp-mcp
curl localhost:3000/health
```

TLS is required, and Caddy obtains a certificate automatically. `/etc/caddy/Caddyfile`:

```
mcp.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Then add `https://mcp.example.org/mcp` as the connector URL.

## With Docker

```bash
docker build -t undp-mcp .
docker run -d --name undp-mcp -p 3000:3000 --restart unless-stopped undp-mcp
```

Still needs a TLS-terminating reverse proxy in front for claude.ai to reach it.

## Operational notes

- **Stateless.** Each request gets a fresh server instance, so you can run several
  replicas behind a load balancer with no session affinity.
- **Memory.** The donor index is ~37 MB parsed and cached for an hour, so size instances
  at 512 MB or more.
- **No authentication.** The UNDP data is public and needs no credentials, so none is
  built in. The endpoint is therefore open to anyone who finds it — the per-IP rate limit
  is the only brake. Put it behind an authenticating proxy if that is not acceptable, and
  note that claude.ai connectors expect OAuth if you want real access control.
- **It calls the UNDP API on a caller's behalf.** Keep the rate limit conservative so a
  hosted instance is not the reason UNDP sees unusual traffic.
