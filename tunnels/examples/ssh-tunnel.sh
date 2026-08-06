# SSH tunnel examples
#
# Mirrors buildSshCommand() in packages/tunnel-core/src/config/ssh.ts.
# Uses the system OpenSSH client; install.sh installs openssh-client + sshpass.

# Local forward: listen on localhost:8080 -> remote host:80 (over the SSH hop)
ssh -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -L 127.0.0.1:8080:127.0.0.1:80 \
  -p 22 user@FOREIGN_HOST

# Remote forward: expose a local service on the remote host
ssh -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -R 127.0.0.1:9090:127.0.0.1:8080 \
  -p 22 user@FOREIGN_HOST

# Dynamic (SOCKS5) forward
ssh -N -D 1080 -p 22 user@FOREIGN_HOST

# With a key (panel materialises the key to a private file and passes -i)
ssh -N -i /var/lib/xistance/tunnels/<id>/id_ed25519 -L 127.0.0.1:8080:127.0.0.1:80 user@FOREIGN_HOST

# With a password, the panel wraps the command in sshpass -e (SSHPASS env var)
sshpass -e ssh -N -L 127.0.0.1:8080:127.0.0.1:80 user@FOREIGN_HOST
