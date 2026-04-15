#!/bin/bash
# Bootstraps a fresh Ubuntu 24.04 host for NanoClaw:
#   - Timezone + swap
#   - Docker (official repo, non-root for 'ubuntu')
#   - Node.js 22 LTS
#   - PostgreSQL 16 (optional, bound to 127.0.0.1)
#   - Build tools (better-sqlite3 needs them), UFW
# Runs ONCE on first boot. Re-running requires instance replacement.

set -euxo pipefail

# ---- Timezone -----------------------------------------------------------
timedatectl set-timezone '${timezone}'

# ---- Swap ---------------------------------------------------------------
# Small instances (2 GiB) need swap to survive agent-container spikes.
if [ "${swap_size_gb}" -gt 0 ] && [ ! -f /swapfile ]; then
  fallocate -l ${swap_size_gb}G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer RAM — only swap under real pressure.
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  sysctl -p /etc/sysctl.d/99-swappiness.conf
fi

# ---- System update ------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

# ---- Base tools ---------------------------------------------------------
apt-get install -y \
  ca-certificates curl gnupg git jq unzip \
  build-essential python3 \
  ufw

# ---- Docker Engine (official repo) --------------------------------------
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
usermod -aG docker ubuntu

# ---- Node.js 22 LTS -----------------------------------------------------
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# ---- PostgreSQL 16 (optional) -------------------------------------------
%{ if install_postgres ~}
apt-get install -y postgresql-16 postgresql-client-16

# Bind only to localhost — other services on the box connect via 127.0.0.1.
# Never exposed to the network; the EC2 SG blocks 5432 anyway.
PG_CONF=/etc/postgresql/16/main/postgresql.conf
sed -i "s/^#\?listen_addresses.*/listen_addresses = '127.0.0.1'/" "$PG_CONF"

systemctl enable --now postgresql

# Create an 'ubuntu' superuser so the default shell user can just run `psql`.
sudo -u postgres psql -c "CREATE ROLE ubuntu WITH LOGIN SUPERUSER;" || true
sudo -u postgres psql -c "CREATE DATABASE ubuntu OWNER ubuntu;" || true
%{ endif ~}

# ---- UFW: SSH in, everything out ----------------------------------------
# EC2 security group is the primary firewall — this is belt-and-suspenders.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable

# ---- Done signal --------------------------------------------------------
echo "nanoclaw-bootstrap-complete $(date -Iseconds)" > /var/log/nanoclaw-bootstrap.done
