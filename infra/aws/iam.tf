# One execution role per app: pull images, write logs, and read only that app's secret (CLAUDE.md §3.8 least
# privilege). Task role: the containers need no AWS APIs (data is on Supabase), so it has no policies.
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each           = local.apps
  name               = "estatecrm-${var.environment_name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secret" {
  for_each = aws_iam_role.execution
  name     = "read-own-secret"
  role     = each.value.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.app[each.key].arn] }]
  })
}

resource "aws_iam_role" "task" {
  name               = "estatecrm-${var.environment_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
