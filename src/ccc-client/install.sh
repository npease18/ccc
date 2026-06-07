#!/bin/bash
set -e

VERSION="${VERSION:-"latest"}"
ORCH_HOST="${ORCH_HOST:-"host.docker.local"}"
ORCH_PORT="${ORCH_PORT:-"9000"}"
ORCH_VERBOSE="${ORCH_VERBOSE:-"false"}"

INSTALL_DIR="/usr/local/bin"

echo "Installing ccc-client..."
echo "  Version:    ${VERSION}"
echo "  ORCH_HOST:  ${ORCH_HOST}"
echo "  ORCH_PORT:  ${ORCH_PORT}"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) ASSET="ccc-client-linux-x64" ;;
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
curl -fsSL --retry 3 "$DOWNLOAD_URL" -o "${INSTALL_DIR}/ccc-client"
chmod +x "${INSTALL_DIR}/ccc-client"
echo "Installed ccc-client to ${INSTALL_DIR}/ccc-client"

# Write start_ccc wrapper — runtime env vars override, install-time values are the defaults
cat > "${INSTALL_DIR}/start_ccc" <<WRAPPER
#!/bin/sh
exec env \\
  ORCH_HOST="\${ORCH_HOST:-${ORCH_HOST}}" \\
  ORCH_PORT="\${ORCH_PORT:-${ORCH_PORT}}" \\
  ORCH_VERBOSE="\${ORCH_VERBOSE:-${ORCH_VERBOSE}}" \\
  ccc-client "\$@"
WRAPPER

chmod +x "${INSTALL_DIR}/start_ccc"
echo "Done. Run 'start_ccc' to connect to the orchestrator."
