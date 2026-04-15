# NanoClaw on AWS (Terraform)

Spin up a single EC2 host with a **fixed public IP** to run NanoClaw. Designed for one person, one instance — not a fleet.

## What this provisions

- **EC2 instance** (Ubuntu 24.04 LTS, ARM by default — `t4g.small`, 2 vCPU / 2 GiB)
- **Elastic IP** — mandatory: WhatsApp Baileys flags IP changes
- **Security group** — SSH in (restrict to your CIDR), everything out
- **Key pair** from your local public key
- **IAM role** for SSM Session Manager (optional — lets you connect without SSH)
- **User data bootstrap** — 2 GiB swap, Docker, Node 22, **PostgreSQL 16 (local)**, UFW

Uses the account's **default VPC**. If you need a dedicated VPC, replace the `data` blocks in `network.tf`.

## Sizing

Default `t4g.small` (2 GiB RAM) is sized for **NanoClaw + 2-3 small Node services + a small Postgres**. A 2 GiB swapfile handles occasional agent-container spikes.

| Workload | Instance | Monthly |
|----------|----------|---------|
| NanoClaw + light services + small PG | `t4g.small` (2 GiB) | ~$12 |
| Heavier agent usage or bigger PG | `t4g.medium` (4 GiB) | ~$25 |
| Lots of node services + PG with real data | `t4g.large` (8 GiB) | ~$50 |

Bump with a single variable change + `terraform apply` — EBS volume stays, state preserved.

## Prerequisites

- Terraform ≥ 1.5
- AWS credentials configured (`aws configure`, `aws sso login`, or `AWS_PROFILE`)
- An SSH keypair (`ssh-keygen -t ed25519` if you don't have one)

## Setup

```bash
cd code/terraform

# 1. Copy and fill in your variables
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

# 2. Init & apply
terraform init
terraform plan
terraform apply
```

Terraform will output the public IP and an SSH command.

## Connect

```bash
# SSH (if ssh_ingress_cidrs allows your IP)
ssh ubuntu@$(terraform output -raw public_ip)

# OR via SSM (no SSH needed — more secure)
aws ssm start-session --target $(terraform output -raw instance_id) --region eu-west-3
```

The first boot takes 2–3 min to install Docker + Node. Check it's done:

```bash
ssh ubuntu@$(terraform output -raw public_ip) 'cat /var/log/nanoclaw-bootstrap.done'
```

## Install NanoClaw

Once on the box:

```bash
# Log out and back in so 'docker' group applies without sudo
exit
ssh ubuntu@<ip>

# Clone your fork
git clone https://github.com/<your-user>/nanoclaw.git
cd nanoclaw

# Run the setup skill via Claude Code, OR manually:
npm install
bash setup.sh
# ... then /setup from Claude Code
```

## Cost estimate (eu-west-3, Paris, on-demand)

| Resource | Monthly (~730h) |
|----------|-----------------|
| `t4g.small` | ~$12 |
| 20 GiB gp3 | ~$2 |
| Elastic IP (attached) | free |
| Elastic IP (unattached — e.g. instance stopped) | ~$4/mo |
| Data transfer out | first 100 GB/mo free, then $0.09/GB |

Total: **~$14/month** running 24/7. Stop the instance when unused → just EIP + disk ≈ $6/mo.

## Security notes

- **Restrict `ssh_ingress_cidrs`** to your public IP. Default `0.0.0.0/0` is open to the internet.
- **IMDSv2 only** — enforced in `ec2.tf`.
- **Encrypted root volume** — enabled.
- **No inbound ports except 22** — NanoClaw doesn't need to serve HTTP.
- `terraform.tfvars` is in `.gitignore` — don't commit your public key if you don't want it linked to this repo publicly.
- Credentials (Anthropic, Slack tokens) stay inside the instance's OneCLI vault — nothing sensitive in Terraform state.

## Destroying

```bash
terraform destroy
```

Wipes the instance and all data. Back up `/home/ubuntu/nanoclaw/store/auth/` first if you want to preserve WhatsApp session.

## File layout

```
code/terraform/
├── versions.tf              # Terraform + AWS provider versions
├── variables.tf             # All inputs
├── network.tf               # VPC data sources, SG, EIP
├── iam.tf                   # SSM role
├── ec2.tf                   # AMI, key pair, instance
├── user-data.sh.tpl         # First-boot bootstrap
├── outputs.tf               # Public IP, SSH/SSM commands
├── terraform.tfvars.example # Template for your vars
├── .gitignore
├── NOTES.md                 # Design decisions & gotchas
└── README.md
```

## Rotating AWS regions / relocating

Changing region = new IP. Don't do this casually with WhatsApp linked — re-auth will be needed each time. Pick a region once and stick with it.
