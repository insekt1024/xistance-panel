# GOST relay examples
#
# gost binary from ginuerzh/gost. Mirrors buildGostCommand() in
# packages/tunnel-core/src/config/gost.ts. The node that owns the source port
# runs the relay; the other node is untouched (unless bidirectional).

# TCP relay: expose local service on this node via port 9090
#   gost -L tcp://:9090/127.0.0.1:8080

# UDP relay
#   gost -L udp://:9090/127.0.0.1:8080

# Bidirectional: both nodes relay each other's ports
#   gost -L tcp://:9090/127.0.0.1:8080
