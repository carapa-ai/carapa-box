#!/bin/sh
# If a generated config from the network policy file exists, use it instead.
set -e

CONF=/run/squid.conf
GENERATED=/etc/squid/squid-generated.conf

# Copy template
cp /etc/squid/squid.conf.tpl "$CONF"

# Prefer generated config if present and non-empty
if [ -s "$GENERATED" ]; then
  echo "[squid-entrypoint] Using generated config from $GENERATED"
  CONF="$GENERATED"
fi

# Logs directory is already mounted with correct uid/gid via tmpfs options
touch /var/log/squid/access.log
tail -F /var/log/squid/access.log &

exec squid -f "$CONF" -NYCd 1
