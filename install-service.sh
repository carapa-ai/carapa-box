#!/bin/bash
set -e

SERVICE_NAME="carapa-box"
INSTALL_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${INSTALL_DIR}/${SERVICE_NAME}.service"
WORKING_DIR="$(pwd)"
BUN_PATH="$(command -v bun || true)"

# Ensure we have Bun
if [ -z "$BUN_PATH" ]; then
    echo "❌ Error: 'bun' not found in PATH."
    exit 1
fi

echo "Installing ${SERVICE_NAME} service..."
echo "  - Working Directory: ${WORKING_DIR}"
echo "  - Bun Path: ${BUN_PATH}"

# Create directory if missing
mkdir -p "$INSTALL_DIR"

# Generate Service File
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CarapaBox (HTTP)
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=${WORKING_DIR}
ExecStart=${BUN_PATH} run start:http
Restart=always
RestartSec=3
TimeoutStopSec=150
Environment=PATH=${PATH}
EnvironmentFile=${WORKING_DIR}/.env


[Install]
WantedBy=default.target
EOF

echo "✅ Created service file: ${SERVICE_FILE}"

# Reload systemd and enable service
echo "Reloading systemd..."
systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}"
echo "✅ Service enabled."

echo ""
echo "🎉 Setup Complete!"
echo "Use the following commands to manage the server:"
echo ""
echo "  Start:    systemctl --user start ${SERVICE_NAME}"
echo "  Stop:     systemctl --user stop ${SERVICE_NAME}"
echo "  Restart:  systemctl --user restart ${SERVICE_NAME}"
echo "  Status:   systemctl --user status ${SERVICE_NAME}"
echo "  Logs:     journalctl --user -u ${SERVICE_NAME} -f"
echo ""
echo "To start it now, run: systemctl --user start ${SERVICE_NAME}"
