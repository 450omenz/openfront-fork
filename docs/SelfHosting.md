# Self-hosting

Runs the game on your own machine and gives it a public HTTPS link through a
free Cloudflare quick tunnel. You don't need a Cloudflare account, a domain or
any router port forwarding.

The server runs in `dev` mode, which doesn't need OpenFront's closed-source
account API.

- **Works:** singleplayer, private lobbies, public lobbies and multiplayer.
- **Doesn't work:** logins, stats, the cosmetics shop, replays and ranked.

## Requirements

- Docker with the compose and buildx plugins (`docker compose version` and
  `docker buildx version` should both print a version). Without buildx the
  build stops at `the --mount option requires BuildKit`. Install it with
  `sudo pacman -S docker-buildx` (Arch) or `sudo apt install docker-buildx-plugin` (Debian/Ubuntu).
- About 4 GB of free RAM to build the image. If the host has less, build on
  another machine instead (see [Low-RAM hosts](#low-ram-hosts)).
- About 5 GB of free disk space.

## Start

```bash
git clone https://github.com/450omenz/openfront-fork.git
cd openfront-fork
docker compose up -d --build
scripts/selfhost-link.sh
```

The first build takes a while. `scripts/selfhost-link.sh` prints a link like
`https://some-random-words.trycloudflare.com`; send it to your friends. One of
you creates a private lobby and the others join with its code or link.

Optional settings, such as the worker count, go in `selfhost.env`:

```bash
cp selfhost.env.example selfhost.env
```

## Day to day

| Task | Command |
|---|---|
| Get the current link | `scripts/selfhost-link.sh` |
| See status | `docker compose ps` |
| Read logs | `docker compose logs -f game` |
| Stop | `docker compose down` |
| Update to the latest code | `git pull && docker compose up -d --build` |

The containers restart on their own after a crash or a reboot, as long as
Docker starts at boot (`sudo systemctl enable docker`).

**The link changes every time the tunnel restarts**, including after a
reboot or an update. Run `scripts/selfhost-link.sh` again and share the new
link. Players in a game when the tunnel restarts get disconnected.

## Low-RAM hosts

Build the image on a bigger machine, then copy it to the host:

```bash
# On the build machine, in the repo:
docker compose build game
docker save openfront-selfhost:latest | gzip > openfront-selfhost.tar.gz
# Copy openfront-selfhost.tar.gz to the host (scp, USB stick, ...).

# On the host, in its clone of the repo:
docker load < openfront-selfhost.tar.gz
docker compose up -d --no-build
scripts/selfhost-link.sh
```

Both machines need the same CPU architecture (e.g. both x86-64). Repeat these
steps for each update.

## A link that doesn't change

A quick tunnel can't keep its address. For a permanent link, use one of these.

### Your own domain (named Cloudflare tunnel)

Needs a domain on your Cloudflare account.

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels →
   Create a tunnel**, choose **Cloudflared**, and name it.
2. Copy the token from the install command it shows (the long string after
   `--token`). Skip the install steps; Docker runs cloudflared for you.
3. Under **Public Hostname**, add a hostname (e.g. `play.example.com`) with
   service type `HTTP` and URL `game:80`.
4. Next to `compose.yaml`, create `.env`:

   ```bash
   COMPOSE_FILE=compose.yaml:compose.cloudflare.yaml
   TUNNEL_TOKEN=<token>
   ```

5. `docker compose up -d --build`. The game is at `https://play.example.com`.

`.env` is gitignored. Keep the token secret: anyone holding it can run your
tunnel. `scripts/selfhost-link.sh` only applies to quick tunnels. To go back
to a quick tunnel, delete `.env` and run `docker compose up -d`.

### Tailscale Funnel

Free. Uncomment the `ports` entry on the `game`
  service in `compose.yaml` and run `tailscale funnel 8080` on the host.
  The link is `https://<machine>.<tailnet>.ts.net`.
