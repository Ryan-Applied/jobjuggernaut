# Tailscale subnet router: one t4g.nano in a private subnet advertising the VPC CIDR.
variable "tailscale_auth_key" { sensitive = true }

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter { name = "name"; values = ["al2023-ami-*-arm64"] }
}

resource "aws_security_group" "ts" {
  name   = "${var.project}-tailscale"
  vpc_id = module.vpc.vpc_id
  egress { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_instance" "tailscale" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = "t4g.nano"
  subnet_id              = module.vpc.private_subnets[0]
  vpc_security_group_ids = [aws_security_group.ts.id]
  source_dest_check      = false
  user_data = <<-EOT
    #!/bin/bash
    curl -fsSL https://tailscale.com/install.sh | sh
    echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.conf && sysctl -p
    tailscale up --authkey=${var.tailscale_auth_key} --advertise-routes=10.42.0.0/16 --hostname=${var.project}-vpc
  EOT
  tags = { Name = "${var.project}-tailscale" }
}
