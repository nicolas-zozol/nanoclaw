# Notes

Design decisions and gotchas for this Terraform setup — read before making changes.

## Secrets hygiene

- `terraform.tfvars` is **gitignored**. Your SSH public key and your SSH ingress CIDR stay local — nothing personal pushed to GitHub.
- Terraform state (`terraform.tfstate`) is also gitignored. It's local-only by default. If you want remote state (S3 backend), add a `backend "s3"` block — but for a single personal instance, local state is fine.
- **No application secrets live in Terraform.** Anthropic token, Slack tokens, WhatsApp creds all live inside the **OneCLI vault** on the EC2 box. Terraform state stays clean.

## NanoClaw install is intentionally NOT automated

User-data only prepares the **host** (Docker, Node 22, Postgres, swap, timezone). It does **not** clone NanoClaw or run `/setup`.

Reason: you run your **own fork** with your own skill branches merged (WhatsApp, Slack, ...). Baking a clone into user-data would either pin to upstream (losing customizations) or require templating your fork URL and branch list — brittle.

**Workflow on first boot:**

```bash
ssh ubuntu@<ip>
git clone https://github.com/<your-user>/nanoclaw.git
cd nanoclaw
# Then run /setup from Claude Code, same as on your laptop.
```

## VPC: using default, not custom

`network.tf` queries the account's **default VPC** via `data` blocks. Simpler, zero cost, one less thing to manage.

**If you want a dedicated VPC** (isolation, tagged subnets, VPC endpoints, multiple instances later), replace the two `data` blocks with `resource "aws_vpc"` / `resource "aws_subnet"` / `resource "aws_internet_gateway"` / route table — see Terraform AWS examples. For one personal box, it's overkill.

## Postgres: on-host, not Docker, not RDS

`install_postgres = true` runs Postgres 16 **natively on the host**, bound to `127.0.0.1`.

Why not Docker? Extra layer, extra RAM, no benefit when it's not ephemeral.
Why not RDS? $15+/mo minimum, overkill for a "petit postgres" next to a personal assistant.

Security: the SG blocks port 5432 from the internet anyway, and `listen_addresses = '127.0.0.1'` makes double-sure. Local Node services connect via `postgresql://ubuntu@127.0.0.1/ubuntu`.

## Elastic IP is enforced

`ec2.tf` has a `lifecycle { precondition }` that **blocks `terraform apply` if `assign_eip = false`**. Rationale: stopping/starting an instance without an EIP rolls the public IPv4 → WhatsApp Baileys sees IP churn → account flags, session drops, potential ban.

If you really need to disable it (you're not using WhatsApp), delete the precondition block.

## Swap: cheap insurance

2 GiB swapfile + `vm.swappiness=10`. On a 2 GiB instance, a spawning agent container can briefly overshoot — without swap, OOM-killer takes NanoClaw down. With swap + low swappiness, RAM stays primary and swap only kicks in during real pressure.

## IMDSv2 enforced, encrypted root, IPv6 egress

- `http_tokens = "required"` blocks IMDSv1 → no SSRF exfil of instance credentials.
- Root volume `encrypted = true`.
- Egress allows both IPv4 and IPv6 (Slack Socket Mode + Anthropic API occasionally resolve AAAA first).

## SSM: connect without opening SSH

With `enable_ssm = true` (default):

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
```

No port 22 exposure, no key management, audit trail in CloudTrail. Recommended for "just SSH into the box sometimes" use.

You can even set `ssh_ingress_cidrs = []`... but Terraform's AWS provider doesn't allow an empty ingress list on a SG rule. Leave it restricted to your IP as a fallback.

## Changing `user_data` replaces the instance

`user_data_replace_on_change = true`. Editing `user-data.sh.tpl` will **destroy and recreate** the EC2 instance on the next apply. You'll lose everything on the root volume (NanoClaw data, WhatsApp auth, Postgres data).

**Before editing user-data**, back up:
- `/home/ubuntu/nanoclaw/store/auth/` (WhatsApp session)
- `/home/ubuntu/nanoclaw/store/messages.db` (chat history)
- `sudo -u postgres pg_dumpall > /tmp/backup.sql` (Postgres)

Or just SSH in and run the equivalent commands by hand — user-data is a one-shot bootstrap, not a config-management tool.

## Region lock-in

Changing `aws_region` = new instance in new region = new IP. Don't switch regions casually once WhatsApp is linked — re-auth needed each time. Pick a region on day 1 and stick with it.

## What's NOT here (on purpose)

- **CloudWatch logs / monitoring**: a single personal box doesn't need it. SSH in and `journalctl -u nanoclaw` works.
- **Automated backups**: roll your own — `cron` + `rsync` to another region or S3 if you care about WhatsApp session survival.
- **Auto-recovery**: a `t4g.small` is reliable; if it dies, `terraform apply` recreates in minutes.
- **Multiple environments (dev/prod)**: this is a personal setup. One env. If you need more, use Terraform workspaces or separate state files.
