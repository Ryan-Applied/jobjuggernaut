# Phase 1 runs entirely on the laptop via docker-compose.dev.yml.
# This file is the cloud shape for the Phase 1 gate review; apply it after the gate.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws       = { source = "hashicorp/aws", version = "~> 5.0" }
    tailscale = { source = "tailscale/tailscale", version = "~> 0.17" }
  }
}

variable "region"     { default = "eu-west-2" }
variable "project"    { default = "jobjuggernaut" }
variable "temporal_cloud_namespace" { description = "Temporal Cloud namespace, e.g. jj.a1b2c" }

provider "aws" { region = var.region }

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  name    = var.project
  cidr    = "10.42.0.0/16"
  azs             = ["${var.region}a", "${var.region}b"]
  private_subnets = ["10.42.1.0/24", "10.42.2.0/24"]
  public_subnets  = ["10.42.101.0/24", "10.42.102.0/24"]
  enable_nat_gateway = true
  single_nat_gateway = true
}

resource "aws_db_subnet_group" "db" { name = "${var.project}-db"; subnet_ids = module.vpc.private_subnets }

resource "aws_db_instance" "postgres" {
  identifier              = "${var.project}-pg"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = "db.t4g.medium"
  allocated_storage       = 50
  db_name                 = "jj"
  username                = "jj"
  manage_master_user_password = true
  db_subnet_group_name    = aws_db_subnet_group.db.name
  publicly_accessible     = false
  skip_final_snapshot     = false
  backup_retention_period = 7
  # pgvector is available on RDS Postgres 16: run `create extension vector` via the migration.
}

resource "aws_ecs_cluster" "main" { name = var.project }

# ECS services for api, cloud worker and indexer: task definitions are added once the images exist (Phase 1 gate).
# Tailscale subnet router: one small EC2 in a private subnet advertising 10.42.0.0/16, auth key from tailscale provider.

resource "aws_s3_bucket" "audit" { bucket = "${var.project}-audit-mirror" }
resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule { default_retention { mode = "GOVERNANCE"; days = 365 } }
}

output "db_endpoint" { value = aws_db_instance.postgres.address }
