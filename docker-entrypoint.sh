#!/bin/sh
# Container entrypoint for the Ratatoskr server.
#
# Transport selection for Ratatoskr's own listener (SPEC section 14). The application itself
# REFUSES to start without a transport decision (TLS, or an explicit plain-HTTP opt-out) so a
# misconfiguration can never silently send credentials in cleartext. This entrypoint adds a
# secure, zero-config default *for the container*: if you supply neither a TLS cert/key nor
# ALLOW_PLAIN_HTTP=true, it generates a persistent self-signed certificate and serves HTTPS with
# it. The Android app trusts a server on first connect by its SHA-256 certificate fingerprint
# (trust-on-first-use), so a self-signed cert is exactly right — compare the fingerprint logged
# below against the one the app shows on its connect screen.
#
# Precedence (highest first), matching the app's config:
#   1. TLS_CERT_PATH + TLS_KEY_PATH  -> serve HTTPS with your own certificate (nothing generated).
#   2. ALLOW_PLAIN_HTTP=true         -> serve plain HTTP (nothing generated).
#   3. otherwise                     -> generate/reuse a self-signed cert in $TLS_AUTO_DIR (/tls).
set -e

TLS_DIR="${TLS_AUTO_DIR:-/tls}"
CERT="$TLS_DIR/cert.pem"
KEY="$TLS_DIR/key.pem"

if [ -z "$TLS_CERT_PATH" ] && [ -z "$TLS_KEY_PATH" ] && [ "$ALLOW_PLAIN_HTTP" != "true" ]; then
  if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    # Fail with an actionable message rather than a raw openssl/permission error. A bind-mounted
    # host directory is often not writable by this non-root user (uid $(id -u)) on first run.
    if ! mkdir -p "$TLS_DIR" 2>/dev/null || [ ! -w "$TLS_DIR" ]; then
      echo "ratatoskr: cannot write to $TLS_DIR to generate a self-signed certificate." >&2
      echo "ratatoskr: make it writable by uid $(id -u) (e.g. 'chown 1000:1000 ./tls'), or set" >&2
      echo "ratatoskr: TLS_CERT_PATH/TLS_KEY_PATH, or ALLOW_PLAIN_HTTP=true." >&2
      exit 1
    fi
    echo "ratatoskr: no TLS configured and ALLOW_PLAIN_HTTP is not set — generating a self-signed certificate at $CERT"
    # -nodes: the key is unencrypted (read unattended at boot). 10-year validity so the pinned
    # fingerprint is long-lived. Subject/SAN are cosmetic here: the app validates by fingerprint,
    # not hostname (trust-on-first-use), so this cert works for any address the app connects to.
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$KEY" -out "$CERT" -days 3650 \
      -subj "/CN=ratatoskr" \
      -addext "subjectAltName=DNS:ratatoskr,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
    chmod 600 "$KEY" 2>/dev/null || true
  else
    echo "ratatoskr: reusing the existing self-signed certificate at $CERT"
  fi

  # Print the SHA-256 fingerprint (lowercase, colon-separated — the app's format) so it can be
  # verified against the connect screen on first use. This is what makes TOFU trustworthy.
  FP="$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 | sed 's/.*=//' | tr 'A-Z' 'a-z')"
  echo "ratatoskr: TLS certificate SHA-256 fingerprint: $FP"
  echo "ratatoskr: verify this against the fingerprint shown in the app on first connect."

  export TLS_CERT_PATH="$CERT"
  export TLS_KEY_PATH="$KEY"
fi

exec "$@"
