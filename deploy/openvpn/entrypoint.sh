#!/bin/sh
set -eu

VPN_DIR=${OPENVPN_DIR:-/vpn}
CONFIG_FILE=${OPENVPN_CONFIG_FILE:-"$VPN_DIR/client.ovpn"}
AUTH_FILE=${OPENVPN_AUTH_FILE:-"$VPN_DIR/auth.txt"}
WORK_DIR=/tmp/openvpn
RUNTIME_CONFIG="$WORK_DIR/client.ovpn"
VERBOSITY=${OPENVPN_VERBOSITY:-3}
IGNORE_REDIRECT_GATEWAY=${OPENVPN_IGNORE_REDIRECT_GATEWAY:-true}
EXTRA_ARGS=${OPENVPN_EXTRA_ARGS:-}

append_if_missing() {
  line="$1"
  pattern="$2"

  if ! grep -Eq "$pattern" "$RUNTIME_CONFIG"; then
    printf '%s\n' "$line" >> "$RUNTIME_CONFIG"
  fi
}

if [ ! -f "$CONFIG_FILE" ]; then
  echo "OpenVPN config not found: $CONFIG_FILE" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
cp "$CONFIG_FILE" "$RUNTIME_CONFIG"

if [ "$IGNORE_REDIRECT_GATEWAY" = "true" ]; then
  sed -i 's/^[[:space:]]*redirect-gateway\b/# disabled redirect-gateway /' "$RUNTIME_CONFIG"
  append_if_missing 'pull-filter ignore redirect-gateway' '^[[:space:]]*pull-filter[[:space:]]+ignore[[:space:]]+redirect-gateway\b'
fi

if [ -f "$AUTH_FILE" ]; then
  if grep -Eq '^[[:space:]]*auth-user-pass(\s+.*)?$' "$RUNTIME_CONFIG"; then
    sed -i "s#^[[:space:]]*auth-user-pass.*#auth-user-pass $AUTH_FILE#" "$RUNTIME_CONFIG"
  else
    printf 'auth-user-pass %s\n' "$AUTH_FILE" >> "$RUNTIME_CONFIG"
  fi
fi

append_if_missing 'auth-nocache' '^[[:space:]]*auth-nocache\b'
append_if_missing 'persist-key' '^[[:space:]]*persist-key\b'
append_if_missing 'persist-tun' '^[[:space:]]*persist-tun\b'
append_if_missing 'resolv-retry infinite' '^[[:space:]]*resolv-retry\b'
append_if_missing 'connect-retry 5' '^[[:space:]]*connect-retry\b'
append_if_missing 'connect-retry-max 0' '^[[:space:]]*connect-retry-max\b'
append_if_missing 'ping 10' '^[[:space:]]*ping\b'
append_if_missing 'ping-restart 60' '^[[:space:]]*ping-restart\b'
append_if_missing "verb $VERBOSITY" '^[[:space:]]*verb\b'

echo "Starting OpenVPN with config: $CONFIG_FILE"
exec sh -c "exec openvpn --config \"$RUNTIME_CONFIG\" $EXTRA_ARGS"
