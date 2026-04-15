variable "aws_region" {
  description = "AWS region for the NanoClaw host. Pick one close to you."
  type        = string
  default     = "eu-west-3" # Paris
}

variable "owner" {
  description = "Your name/handle, attached as a tag to every resource."
  type        = string
}

variable "name" {
  description = "Short name for this deployment (used as resource name prefix)."
  type        = string
  default     = "nanoclaw"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. Defaults to ARM (t4g.small: 2 vCPU / 2 GiB RAM, ~$12/mo).
    Sized for: NanoClaw + 2-3 small Node services + a small Postgres.
    A 2 GiB swapfile is added by user-data to absorb agent-container spikes.

    Upgrade to t4g.medium (4 GiB, ~$25/mo) if you run the agent heavily
    (>1 spawn/min) or host a larger Postgres.

    Use t3.small / t3.medium for x86_64 if an npm package lacks arm64 builds.
  EOT
  type        = string
  default     = "t4g.small"
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size (GiB). Docker images + NanoClaw data + Postgres."
  type        = number
  default     = 20
}

variable "swap_size_gb" {
  description = "Swapfile size in GiB. Cushions agent-container RAM spikes on small instances."
  type        = number
  default     = 2
}

variable "install_postgres" {
  description = <<-EOT
    Install PostgreSQL 16 on the host (bound to 127.0.0.1, no external access).
    Convenient for "a small Postgres next to NanoClaw" without Docker overhead.
    Disable if you'd rather run it yourself in a container or use RDS.
  EOT
  type        = bool
  default     = true
}

variable "ssh_ingress_cidrs" {
  description = <<-EOT
    CIDRs allowed to SSH to the instance.
    SET THIS TO YOUR PUBLIC IP (e.g. ["203.0.113.42/32"]).
    Default 0.0.0.0/0 is open to the internet — fine only with strong key auth, but not recommended.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_public_key" {
  description = <<-EOT
    Your SSH public key contents (e.g. file("~/.ssh/id_ed25519.pub")).
    This is what you'll use to SSH into the box.
  EOT
  type        = string
  sensitive   = false
}

variable "assign_eip" {
  description = <<-EOT
    Attach an Elastic IP so the public address stays fixed across reboots/stops.
    REQUIRED for WhatsApp — rotating IPs trigger account flags.
  EOT
  type        = bool
  default     = true
}

variable "timezone" {
  description = "IANA timezone for the host (used by systemd + NanoClaw scheduler)."
  type        = string
  default     = "Europe/Paris"
}

variable "enable_ssm" {
  description = <<-EOT
    Attach an IAM role for AWS Systems Manager Session Manager.
    Lets you connect without opening SSH at all (via `aws ssm start-session`).
    Recommended: true, then restrict ssh_ingress_cidrs to your own IP anyway.
  EOT
  type        = bool
  default     = true
}
