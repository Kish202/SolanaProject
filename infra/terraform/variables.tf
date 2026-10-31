variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Subnets for the load balancer"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Subnets for the app instances and Redis (outbound internet via NAT for Solana RPC, Jupiter and Supabase)"
}

variable "certificate_arn" {
  type        = string
  description = "ACM certificate for the HTTPS listener"
}

variable "alert_email" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

variable "sponsor_low_balance_lamports" {
  type    = number
  default = 2000000000 # 2 SOL
}
