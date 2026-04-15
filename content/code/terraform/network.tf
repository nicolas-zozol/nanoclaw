# Use the account's default VPC/subnet to keep this minimal.
# If you want a dedicated VPC, replace these data sources with aws_vpc / aws_subnet resources.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "nanoclaw" {
  name        = "${var.name}-sg"
  description = "NanoClaw host: SSH in, everything out."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_ingress_cidrs
  }

  egress {
    description      = "All outbound (WhatsApp, Slack, Anthropic API, apt, Docker Hub, ...)"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = {
    Name = "${var.name}-sg"
  }
}

resource "aws_eip" "nanoclaw" {
  count    = var.assign_eip ? 1 : 0
  instance = aws_instance.nanoclaw.id
  domain   = "vpc"

  tags = {
    Name = "${var.name}-eip"
  }
}
