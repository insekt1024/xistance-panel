# REVERSE tunnel examples — NAT-friendly relay across Iran + Foreign.
#
# Mirrors buildReverseCommand()/buildReversePair() in
# packages/tunnel-core/src/config/reverse.ts. The Iran node dials OUT to the
# Foreign node, so Iran needs NO inbound firewall rule; the Foreign node
# exposes the public port.

# --- Foreign node (public entrypoint, port 8080) ---
#   gost -L tcp://:8080/127.0.0.1:8080

# --- Iran node (dials out to Foreign 203.0.113.10, bridges the local service) ---
#   gost -L tcp://:80/127.0.0.1:80 -F tcp://203.0.113.10:8080

# UDP variant (same shape, udp:// scheme on both ends)
#   Foreign: gost -L udp://:8080/127.0.0.1:8080
#   Iran:    gost -L udp://:80/127.0.0.1:80 -F udp://203.0.113.10:8080
