# Public entry: HTTPS on the product domain. Paths are forwarded unchanged; the apps accept their own prefixes
# (src/entry.ts): /svc/<svc>/* → that service (scheduler, health), /public/* → listings (website API), the rest → web.
resource "aws_acm_certificate" "main" {
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# Waits until the DNS record from the `certificate_validation` output exists at the domain's DNS provider, so it is
# only created with launch = true (the second apply).
resource "aws_acm_certificate_validation" "main" {
  count           = var.launch ? 1 : 0
  certificate_arn = aws_acm_certificate.main.arn
}

resource "aws_lb" "main" {
  name                       = "estatecrm-${var.environment_name}"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 120 # chat answers stream for up to 15 s; uploads up to 60 s
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "app" {
  for_each             = local.apps
  name                 = "estatecrm-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 20
  health_check {
    path                = "/health/live"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.launch ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["web"].arn
  }
}

locals {
  backend_apps = [for k in sort(keys(local.apps)) : k if k != "web"]
}

resource "aws_lb_listener_rule" "svc" {
  for_each     = var.launch ? toset(local.backend_apps) : toset([])
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10 + index(local.backend_apps, each.key)
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[each.key].arn
  }
  condition {
    path_pattern {
      values = ["/svc/${each.key}/*"]
    }
  }
}

resource "aws_lb_listener_rule" "public_feed" {
  count        = var.launch ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 5
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["listings"].arn
  }
  condition {
    path_pattern {
      values = ["/public/v1/*"]
    }
  }
}
