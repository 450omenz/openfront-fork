# Self-hosting

Runs the game on your own machine and gives it a public HTTPS link through a
free Cloudflare quick tunnel. You don't need a Cloudflare account, a domain or
any router port forwarding.

The server runs in `dev` mode, which doesn't need OpenFront's closed-source
account API.

- **Works:** singleplayer, private lobbies, public lobbies and multiplayer.
- **Doesn't work:** logins, stats, the cosmetics shop, replays and ranked.

## Requirements

- Docker with the compose plugin (`docker compose version` should print a version).
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

The repo is private, so `git clone` asks for credentials. Either run
`gh auth login` first, or enter your GitHub username and a personal access
token as the password.

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

A quick tunnel can't keep its address. For a permanent link, use one of these:

- **Named Cloudflare tunnel:** needs a domain on Cloudflare (about $10/year).
  Create a tunnel in the Cloudflare Zero Trust dashboard and point its public
  hostname at `http://game:80`. Then change the `tunnel` service's command
  to `tunnel --no-autoupdate run --token <token>`.
- **Tailscale Funnel:** free. Uncomment the `ports` entry on the `game`
  service in `compose.yaml` and run `tailscale funnel 8080` on the host.
  The link is `https://<machine>.<tailnet>.ts.net`.
