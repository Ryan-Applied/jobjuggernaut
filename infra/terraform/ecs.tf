# ECS Fargate services for the cloud half. Images come from ECR (build with: docker build --target api -t ... .)
variable "image_tag" { default = "latest" }
variable "temporal_address" { description = "Temporal Cloud address, e.g. ns.a1b2c.tmprl.cloud:7233" }
variable "temporal_namespace" { default = "default" }

resource "aws_ecr_repository" "jj" { name = var.project }

resource "aws_cloudwatch_log_group" "jj" { name = "/jj"; retention_in_days = 30 }

resource "aws_iam_role" "task" {
  name = "${var.project}-task"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "exec" { role = aws_iam_role.task.name; policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" }

resource "aws_secretsmanager_secret" "env" { name = "${var.project}/env" }  # DATABASE_URL, LEDGER_SIGNING_SECRET, SLACK_*, VOYAGE_API_KEY, TEMPORAL_API_KEY

locals {
  services = {
    api          = { target = "api",          cpu = 512, memory = 1024, port = 4000 }
    cloud-worker = { target = "cloud-worker", cpu = 512, memory = 1024, port = null }
    indexer      = { target = "indexer",      cpu = 512, memory = 1024, port = null }
  }
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.services
  family                   = "${var.project}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.task.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name  = each.key
    image = "${aws_ecr_repository.jj.repository_url}:${each.value.target}-${var.image_tag}"
    portMappings = each.value.port == null ? [] : [{ containerPort = each.value.port }]
    environment = [
      { name = "TEMPORAL_ADDRESS", value = var.temporal_address },
      { name = "TEMPORAL_NAMESPACE", value = var.temporal_namespace },
      { name = "API_URL", value = "http://api.${var.project}.local:4000" },
    ]
    secrets = [for k in ["DATABASE_URL", "LEDGER_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_APPROVALS_CHANNEL", "VOYAGE_API_KEY"] : { name = k, valueFrom = "${aws_secretsmanager_secret.env.arn}:${k}::" }]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.jj.name, awslogs-region = var.region, awslogs-stream-prefix = each.key } }
  }])
}

resource "aws_service_discovery_private_dns_namespace" "local" { name = "${var.project}.local"; vpc = module.vpc.vpc_id }
resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config { namespace_id = aws_service_discovery_private_dns_namespace.local.id; dns_records { ttl = 10; type = "A" } }
}

resource "aws_security_group" "svc" {
  name   = "${var.project}-svc"
  vpc_id = module.vpc.vpc_id
  ingress { from_port = 4000; to_port = 4000; protocol = "tcp"; cidr_blocks = ["10.42.0.0/16", "100.64.0.0/10"] } # VPC + Tailscale CGNAT range
  egress  { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_ecs_service" "svc" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.svc[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration { subnets = module.vpc.private_subnets; security_groups = [aws_security_group.svc.id] }
  dynamic "service_registries" { for_each = each.key == "api" ? [1] : []; content { registry_arn = aws_service_discovery_service.api.arn } }
}

# The laptop reaches api.jobjuggernaut.local:4000 and RDS over Tailscale via the subnet router (infra/terraform/tailscale.tf, next).
