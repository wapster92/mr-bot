FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openvpn iproute2 ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY deploy/openvpn/entrypoint.sh /usr/local/bin/openvpn-entrypoint.sh
RUN chmod +x /usr/local/bin/openvpn-entrypoint.sh

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/openvpn-entrypoint.sh"]
