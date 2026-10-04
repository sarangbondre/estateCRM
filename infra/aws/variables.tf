variable "region" {
  description = "AWS region (data stays in India, BRD A-10)"
  type        = string
  default     = "ap-south-1"
}

variable "environment_name" {
  description = "pilot | staging | production (shown in logs and alarms)"
  type        = string
  default     = "pilot"
}

variable "domain" {
  description = "Host name the CRM is served on, e.g. crm.11estates.in (ACM certificate, APP_ORIGIN)"
  type        = string
}

variable "tenant_id" {
  description = "The single Phase 1 tenant (WEB_TENANT_ID / RECORDS_TENANT_IDS)"
  type        = string
  default     = "11e00000-0000-4000-8000-000000000001"
}

variable "supabase_url" {
  description = "https://<project-ref>.supabase.co"
  type        = string
}

variable "launch" {
  description = "false on the first apply (network, registry, secrets, certificate request); true once images are pushed, secrets written and the certificate DNS record added"
  type        = bool
  default     = false
}

variable "min_tasks" {
  description = "Minimum running tasks per app (CLAUDE.md §3.6: at least 2)"
  type        = number
  default     = 2
}

variable "max_tasks" {
  description = "Autoscaling ceiling per app; the DB pool budget allows 14 tasks x POOL_MAX 3"
  type        = number
  default     = 4
}

variable "alarm_email" {
  description = "Where CloudWatch alarms are e-mailed (subscription must be confirmed once); empty = no e-mail"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}
