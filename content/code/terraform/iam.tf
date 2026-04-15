# IAM role for SSM Session Manager (optional but recommended).
# Lets you: `aws ssm start-session --target <instance-id>` without exposing SSH.

resource "aws_iam_role" "ssm" {
  count = var.enable_ssm ? 1 : 0
  name  = "${var.name}-ssm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  count      = var.enable_ssm ? 1 : 0
  role       = aws_iam_role.ssm[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nanoclaw" {
  count = var.enable_ssm ? 1 : 0
  name  = "${var.name}-instance-profile"
  role  = aws_iam_role.ssm[0].name
}
