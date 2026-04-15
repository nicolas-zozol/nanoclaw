locals {
  # t4g.* / a1.* / c7g.* / m7g.* etc. are Graviton (arm64)
  is_arm64 = can(regex("^[a-z]+[0-9]+g", var.instance_type))
  arch     = local.is_arm64 ? "arm64" : "amd64"
}

# Ubuntu 24.04 LTS — canonical's official AMI, queried dynamically so we
# always boot the latest patched image.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${local.arch}-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "nanoclaw" {
  key_name   = "${var.name}-key"
  public_key = var.ssh_public_key
}

resource "aws_instance" "nanoclaw" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.nanoclaw.key_name
  vpc_security_group_ids = [aws_security_group.nanoclaw.id]
  subnet_id              = data.aws_subnets.default.ids[0]

  iam_instance_profile = var.enable_ssm ? aws_iam_instance_profile.nanoclaw[0].name : null

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name = "${var.name}-root"
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # Docker containers need hop 2 if they hit IMDS
  }

  user_data = templatefile("${path.module}/user-data.sh.tpl", {
    timezone         = var.timezone
    swap_size_gb     = var.swap_size_gb
    install_postgres = var.install_postgres
  })

  # Force instance replacement when user-data changes (safe — it only runs on first boot anyway).
  user_data_replace_on_change = true

  tags = {
    Name = var.name
  }

  # If you reboot or stop/start without an EIP, the public IPv4 changes → WhatsApp hates that.
  lifecycle {
    precondition {
      condition     = var.assign_eip
      error_message = "assign_eip must be true — a stable public IP is required for WhatsApp Baileys."
    }
  }
}
