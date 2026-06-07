#!/bin/bash
set -e

VERSION="${VERSION:-"latest"}"
INSTALL_DIR="${INSTALL_DIR:-"${HOME}/.local/bin"}"
BINARY_NAME="ccc-server"
MCP_SERVER_KEY="ccc-orchestrator"


echo "Installing ${BINARY_NAME}..."
echo "  Version:     ${VERSION}"
echo "  Install dir: ${INSTALL_DIR}"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) ASSET="ccc-server-linux-x64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Resolve download URL
if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/npease18/ccc/releases/latest/download/${ASSET}"
else
    DOWNLOAD_URL="https://github.com/npease18/ccc/releases/download/${VERSION}/${ASSET}"
fi

# Ensure curl is available
if ! command -v curl > /dev/null 2>&1; then
    apt-get update -y && apt-get install -y --no-install-recommends curl ca-certificates
fi

echo "Downloading from ${DOWNLOAD_URL}..."
curl -fsSL --retry 3 "$DOWNLOAD_URL" -o "${INSTALL_DIR}/${BINARY_NAME}"
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

# Register the MCP server with Claude
SERVER_PATH="${INSTALL_DIR}/${BINARY_NAME}"

echo "Registering MCP server '${MCP_SERVER_KEY}' with Claude..."

if ! command -v claude > /dev/null 2>&1; then
    echo "Warning: 'claude' CLI not found. Register manually with:" >&2
    echo "  claude mcp add -s user ${MCP_SERVER_KEY} -- ${SERVER_PATH}" >&2
else
    claude mcp add -s user "${MCP_SERVER_KEY}" -- "${SERVER_PATH}"
    echo "  Registered '${MCP_SERVER_KEY}' -> ${SERVER_PATH}"
fi

echo "Done. Restart Claude to pick up the new MCP server."
