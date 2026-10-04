output "certificate_validation" {
  description = "Add this CNAME at the domain's DNS provider so the HTTPS certificate is issued"
  value = [for o in aws_acm_certificate.main.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}

output "load_balancer_dns" {
  description = "Point the domain (CNAME, or an alias record on Route 53) at this name"
  value       = aws_lb.main.dns_name
}

output "nat_egress_ip" {
  description = "Fixed outbound IP of the tasks (for allow-lists, e.g. Supabase network restrictions)"
  value       = aws_eip.nat.public_ip
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}
