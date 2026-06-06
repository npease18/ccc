# ccc — Claude Cross Container

Runs an MCP orchestrator server in WSL that accepts connections from clients running in dev containers (or any remote environment), allowing Claude to execute commands and read files across container boundaries.

## Architecture

```
┌─────────────────────┐        TCP        ┌──────────────────────┐
│   Dev Container     │  ───────────────► │        WSL           │
│                     │     port 9000     │                      │
│   ccc-client        │                  │   ccc-server (MCP)   │
│  (runs in project)  │ ◄─────────────── │  (orchestrates all   │
│                     │   RPC responses   │      clients)        │
└─────────────────────┘                  └──────────────────────┘
                                                    ▲
                                                    │ stdio
                                                    ▼
                                               Claude / MCP Host
```

- **Server** (`ccc-server`) — MCP server + TCP orchestrator. Runs in WSL, exposes port 9000, communicates with Claude via stdio.
- **Client** (`ccc-client`) — Runs inside each dev container. Connects to the server and executes commands/reads files on behalf of the orchestrator.

## Setup

### Using Release Binaries

Download the latest binaries from the [GitHub Releases](https://github.com/npease18/ccc/releases) page.

Each release includes:
- `ccc-server-linux-x64` — The MCP orchestrator server
- `ccc-client-linux-x64` — The client to run in each dev container
- `SHA256SUMS` — Checksums for verifying downloads

**Verify the download:**
```bash
sha256sum -c SHA256SUMS
```

**Make binaries executable:**
```bash
chmod +x ccc-server-linux-x64 ccc-client-linux-x64
```

### Register the MCP Server with Claude

Run the following command in WSL to register the MCP server (adjust the path to where you placed the binary):

```bash
# Using a release binary
claude mcp add -s user ccc-orchestrator -- /path/to/ccc-server-linux-x64

# Or from source (requires Bun)
claude mcp add -s user ccc-orchestrator -- /home/npease/.bun/bin/bun /home/npease/repos/ccc/mcp-server/index.ts
```

The `-s user` flag registers the server at the user scope, making it available across all Claude sessions.

### Run the Client in a Dev Container

Start the client from inside the dev container, pointing it at the WSL host:

```bash
# Using a release binary
ORCH_HOST=ccc-orchestrator ./ccc-client-linux-x64

# Or from source (requires Bun)
ORCH_HOST=ccc-orchestrator bun run client/index.ts
```

If using the provided `.devcontainer/devcontainer.json`, the `ccc-orchestrator` hostname is automatically mapped to the WSL host via Docker's `host-gateway`.

## Environment Variables

### Client

| Variable | Default | Description |
|---|---|---|
| `ORCH_HOST` | `127.0.0.1` | Hostname or IP of the orchestrator server. Set to `ccc-orchestrator` when running in a dev container. |
| `ORCH_PORT` | `9000` | TCP port the orchestrator server listens on. |
| `ORCH_VERBOSE` | `false` | Set to `true` to enable verbose debug logging (full request/response bodies, stream chunk previews, stack traces on errors). |

### Server

The server currently uses hardcoded defaults (`0.0.0.0:9000`) and is configured via the MCP host (Claude).

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