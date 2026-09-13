# REVERSE tunnel examples — one-click ssh -R reverse forward.
#
# Mirrors reverseToSshConfig() in packages/tunnel-core/src/config/reverse.ts
# plus buildSshCommand()/buildAutosshCommand() in config/ssh.ts.
# Runs ON the Iran node and dials OUT to the Foreign sshd, so Iran needs no
# inbound firewall rule. TCP only (OpenSSH -R cannot forward UDP).

# Expose Iran-local service 127.0.0.1:80 on Foreign *:8080
#   ssh -N \
#     -o ServerAliveInterval=30 \
#     -o ServerAliveCountMax=3 \
#     -o ExitOnForwardFailure=yes \
#     -o StrictHostKeyChecking=accept-new \
#     -R 0.0.0.0:8080:127.0.0.1:80 \
#     -p 22 root@FOREIGN_HOST

# Same, wrapped in autossh so the client respawns the moment the link drops
# (the panel sets AUTOSSH_GATETIME=0 / AUTOSSH_POLL and falls back to plain
# ssh when autossh is not installed on the node)
#   autossh -M 0 -N \
#     -o ServerAliveInterval=30 \
#     -o ServerAliveCountMax=3 \
#     -o ExitOnForwardFailure=yes \
#     -o StrictHostKeyChecking=accept-new \
#     -R 0.0.0.0:8080:127.0.0.1:80 \
#     -p 22 root@FOREIGN_HOST

# With a password, the panel wraps the command in sshpass -e (SSHPASS env var)
#   sshpass -e ssh -N -R 0.0.0.0:8080:127.0.0.1:80 user@FOREIGN_HOST
