# ccc — Claude Cross Container

Runs an MCP orchestrator server in WSL that accepts connections from clients running in dev containers (or any remote environment), allowing Claude to execute commands and read files across container boundaries.

## Architecture

```
┌─────────────────────┐        TCP        ┌──────────────────────┐
│   Dev Container     │  ───────────────► │        WSL           │
│                     │     port 9000     │                      │
│   ccc-client        │                   │   ccc-server (MCP)   │
│  (runs in project)  │ ◄───────────────  │  (orchestrates all   │
│                     │   RPC responses   │      clients)        │
└─────────────────────┘                   └──────────────────────┘
                                                    ▲
                                                    │ stdio
                                                    ▼
                                               Claude / MCP Host
```

- **Server** (`ccc-server`) — MCP server + TCP orchestrator. Runs in WSL, exposes port 9000, communicates with Claude via stdio.
- **Client** (`ccc-client`) — Runs inside each dev container. Connects to the server and executes commands/reads files on behalf of the orchestrator.

## Setup

### Install the Server

Run the following in WSL to download the `ccc-server` binary and register it with Claude in one step:

```bash
curl -fsSL https://raw.githubusercontent.com/npease18/ccc/main/install-server.sh | bash
```

Or with zsh:

```bash
curl -fsSL https://raw.githubusercontent.com/npease18/ccc/main/install-server.sh | zsh
```

To pin a specific release version:

```bash
curl -fsSL https://raw.githubusercontent.com/npease18/ccc/main/install-server.sh | VERSION=main-abc1234... bash
```

The script installs the binary to `/usr/local/bin/ccc-server` and registers it as `ccc-orchestrator` in `~/.claude.json`. Restart Claude after running it.

### Using Release Binaries Directly

Binaries are also available on the [GitHub Releases](https://github.com/npease18/ccc/releases) page if you prefer a manual install. Each release includes:
- `ccc-server-linux-x64` — The MCP orchestrator server
- `ccc-client-linux-x64` — The client to run in each dev container
- `SHA256SUMS` — Checksums for verifying downloads

### Install the Client in a Dev Container

The recommended way to run the client is via the [Dev Container feature](https://containers.dev/implementors/features/). Add it to your `.devcontainer/devcontainer.json`:

```json
{
  "features": {
    "ghcr.io/npease18/ccc/ccc-client:latest": {}
  }
}
```

This installs the `ccc-client` binary and a `ccc` wrapper command that automatically connects to the orchestrator on `host.docker.internal:9000` when the container starts.

**Available options:**

```json
{
  "features": {
    "ghcr.io/npease18/ccc/ccc-client:latest": {
      "version": "latest",
      "orch_host": "host.docker.internal",
      "orch_port": "9000",
      "orch_verbose": false
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `version` | `latest` | Release version to install. Use `latest` or a specific tag (e.g. `main-abc1234...`). |
| `orch_host` | `host.docker.internal` | Hostname or IP of the orchestrator server. |
| `orch_port` | `9000` | TCP port the orchestrator listens on. |
| `orch_verbose` | `false` | Enable verbose debug logging on the client. |

## Environment Variables

### Client

| Variable | Default | Description |
|---|---|---|
| `ORCH_HOST` | `127.0.0.1` | Hostname or IP of the orchestrator server. Set to `ccc-orchestrator` when running in a dev container. |
| `ORCH_PORT` | `9000` | TCP port the orchestrator server listens on. |
| `ORCH_VERBOSE` | `false` | Set to `true` to enable verbose debug logging (full request/response bodies, stream chunk previews, stack traces on errors). |

## Logging

The client supports two logging modes:

**Default** — Errors, warnings, and connection lifecycle events only.

**Verbose** (`ORCH_VERBOSE=true`) — Full debug output including:
- Incoming RPC request bodies
- Response status and result summaries
- stdout/stderr stream chunk previews
- Command exit codes and signals
- Stack traces on errors

```bash
ORCH_VERBOSE=true ./ccc-client-linux-x64
```

## Development

**Install dependencies:**
```bash
bun install
```

**Run from source:**
```bash
# In WSL — start the MCP server
bun run start:server

# In dev container — start the client
bun run start:client
```

**Typecheck:**
```bash
bun run typecheck
```

Release binaries are built automatically on every push to `main` via GitHub Actions.