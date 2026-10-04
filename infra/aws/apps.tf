# The seven apps (apps.json): image repository, secret, log group, task definition and ECS service for each.
locals {
  apps_raw = { for k, v in jsondecode(file("${path.module}/apps.json")) : k => v if k != "_comment" }
  fill = {
    "$${domain}"       = var.domain
    "$${tenant_id}"    = var.tenant_id
    "$${supabase_url}" = trimsuffix(var.supabase_url, "/")
    "$${storage_url}"  = "${trimsuffix(var.supabase_url, "/")}/storage/v1"
  }
  apps = {
    for name, a in local.apps_raw : name => merge(a, {
      env = merge(
        { for k, v in a.env : k => replace(replace(replace(replace(v, "$${domain}", local.fill["$${domain}"]), "$${tenant_id}", local.fill["$${tenant_id}"]), "$${supabase_url}", local.fill["$${supabase_url}"]), "$${storage_url}", local.fill["$${storage_url}"]) },
        { ENVIRONMENT_NAME = var.environment_name, PORT = tostring(a.port), NODE_ENV = "production" },
      )
    })
  }
}

resource "aws_ecr_repository" "app" {
  for_each             = local.apps
  name                 = "estatecrm/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# One JSON secret per app; values are written by the aws-secrets workflow (never by Terraform, never in state).
resource "aws_secretsmanager_secret" "app" {
  for_each                = local.apps
  name                    = "estatecrm/${var.environment_name}/${each.key}"
  recovery_window_in_days = 7
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.apps
  name              = "/estatecrm/${var.environment_name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = "estatecrm-${var.environment_name}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  service_connect_defaults {
    namespace = aws_service_discovery_http_namespace.main.arn
  }
}

resource "aws_service_discovery_http_namespace" "main" {
  name = "estatecrm-${var.environment_name}"
}

# The image each app runs: written by the aws-deploy workflow (commit SHA), read here so that a Terraform change (e.g.
# a new environment variable) keeps the deployed image. "bootstrap" until the first deploy.
resource "aws_ssm_parameter" "image_tag" {
  for_each       = local.apps
  name           = "/estatecrm/${var.environment_name}/image/${each.key}"
  type           = "String"
  insecure_value = "bootstrap"
  lifecycle {
    ignore_changes = [insecure_value]
  }
}

# Always the live value (what the last deploy wrote), not Terraform's remembered one.
data "aws_ssm_parameter" "image_tag" {
  for_each   = local.apps
  name       = aws_ssm_parameter.image_tag[each.key].name
  depends_on = [aws_ssm_parameter.image_tag]
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.apps
  family                   = "estatecrm-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = each.key
    image        = "${aws_ecr_repository.app[each.key].repository_url}:${data.aws_ssm_parameter.image_tag[each.key].insecure_value}"
    essential    = true
    portMappings = [{ name = each.key, containerPort = each.value.port, protocol = "tcp", appProtocol = "http" }]
    environment  = [for k, v in each.value.env : { name = k, value = v }]
    secrets      = [for k, _ in each.value.secrets : { name = k, valueFrom = "${aws_secretsmanager_secret.app[each.key].arn}:${k}::" }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${each.value.port}/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

# Services start with launch = true: after the images are pushed, the secrets written and the certificate issued.
resource "aws_ecs_service" "app" {
  for_each                           = var.launch ? local.apps : {}
  name                               = each.key
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app[each.key].arn
  desired_count                      = var.min_tasks
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  enable_execute_command             = false
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app[each.key].arn
    container_name   = each.key
    container_port   = each.value.port
  }
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn
    service {
      port_name = each.key
      client_alias {
        dns_name = each.key
        port     = each.value.port
      }
    }
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
  depends_on = [aws_lb_listener.https, aws_lb_listener_rule.svc, aws_lb_listener_rule.public_feed]
}

resource "aws_appautoscaling_target" "app" {
  for_each           = var.launch ? local.apps : {}
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_tasks
  max_capacity       = var.max_tasks
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.app
  name               = "estatecrm-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
