# DIRECT tunnel examples — single-node forward, no peer dial.
#
# Mirrors buildDirectCommand() in packages/tunnel-core/src/config/direct.ts.
# Runs on ONE node only (the panel prefers the Foreign node, closest to the
# target service). Use when both ends are directly reachable.

# TCP: listen on :8080, forward to the service at 127.0.0.1:80
#   gost -L tcp://:8080/127.0.0.1:80

# UDP: same idea over UDP (games, voice, WireGuard, …)
#   gost -L udp://:51820/127.0.0.1:51820

# Custom bind address (listen on one interface only)
#   gost -L tcp://127.0.0.1:8080/127.0.0.1:80
