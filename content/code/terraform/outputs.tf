output "instance_id" {
  description = "EC2 instance ID (use with `aws ssm start-session --target <id>`)."
  value       = aws_instance.nanoclaw.id
}

output "public_ip" {
  description = "Fixed public IPv4 of the NanoClaw host (Elastic IP if enabled, else ephemeral)."
  value       = var.assign_eip ? aws_eip.nanoclaw[0].public_ip : aws_instance.nanoclaw.public_ip
}

output "public_dns" {
  description = "Public DNS name of the instance."
  value       = aws_instance.nanoclaw.public_dns
}

output "ssh_command" {
  description = "Copy-paste SSH command to connect."
  value       = "ssh ubuntu@${var.assign_eip ? aws_eip.nanoclaw[0].public_ip : aws_instance.nanoclaw.public_ip}"
}

output "ssm_command" {
  description = "SSM Session Manager command (only if enable_ssm = true)."
  value       = var.enable_ssm ? "aws ssm start-session --target ${aws_instance.nanoclaw.id} --region ${var.aws_region}" : "disabled"
}

output "bootstrap_check" {
  description = "Run this after first boot to confirm user-data finished."
  value       = "ssh ubuntu@${var.assign_eip ? aws_eip.nanoclaw[0].public_ip : aws_instance.nanoclaw.public_ip} 'cat /var/log/nanoclaw-bootstrap.done'"
}
