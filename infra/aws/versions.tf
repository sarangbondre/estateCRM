# AWS compute for the 11estates CRM (CR-018, option A): web + six services on ECS Fargate in Mumbai; Supabase keeps the
# data. State lives in the S3 bucket created by bootstrap/bootstrap.yaml (backend settings passed at `terraform init`).
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    key          = "estatecrm/aws.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "estatecrm"
      Environment = var.environment_name
      ManagedBy   = "terraform"
    }
  }
}
