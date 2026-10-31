terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # backend "s3" { bucket = "your-tf-state", key = "solana-trade/terraform.tfstate", region = "ap-south-1", use_lockfile = true }
}

provider "aws" {
  region = var.region
}

# Runtime: Elastic Beanstalk on the managed Node.js platform (no containers).
# Database: Supabase Postgres (managed outside AWS; connection string stored in Secrets Manager).
# Cache / pub-sub / rate limits: ElastiCache Redis inside the VPC.

locals {
  name     = "solana-trade"
  env_name = "solana-trade-api"
  # Beanstalk streams each Procfile process's stdout to its own log group.
  app_log_group = "/aws/elasticbeanstalk/${local.env_name}/var/log/web.stdout.log"
}

data "aws_elastic_beanstalk_solution_stack" "node" {
  most_recent = true
  name_regex  = "^64bit Amazon Linux 2023 (.*) running Node.js 22$"
}

# ---------------- Security groups ----------------

resource "aws_security_group" "app" {
  name   = "${local.name}-app"
  vpc_id = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"] # Solana RPC, Jupiter, Supabase via NAT
  }
}

resource "aws_security_group" "redis" {
  name   = "${local.name}-redis"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

# ---------------- Redis (ElastiCache) ----------------

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = local.name
  description                = "price cache, pub/sub, rate limits"
  engine                     = "redis"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
}

# ---------------- Secrets ----------------
# The value is set out-of-band (console / CLI), never in Terraform state or git. JSON keys:
#   DATABASE_URL (Supabase session pooler), DATABASE_SSL_CA (Supabase CA cert),
#   SPONSOR_SECRET_KEY, ADMIN_API_KEY, SOLANA_RPC_URL, SOLANA_SEND_RPC_URLS,
#   PLATFORM_FEE_OWNER, CORS_ORIGINS

resource "aws_secretsmanager_secret" "app" {
  name = "${local.name}/app"
}

# ---------------- IAM ----------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "instance_web_tier" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier"
}

resource "aws_iam_role_policy" "instance_secret" {
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.app.arn]
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}

data "aws_iam_policy_document" "eb_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["elasticbeanstalk.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "service" {
  name               = "${local.name}-eb-service"
  assume_role_policy = data.aws_iam_policy_document.eb_assume.json
}

resource "aws_iam_role_policy_attachment" "service_health" {
  role       = aws_iam_role.service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth"
}

resource "aws_iam_role_policy_attachment" "service_updates" {
  role       = aws_iam_role.service.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy"
}

# ---------------- App bundles ----------------

resource "aws_s3_bucket" "bundles" {
  bucket_prefix = "${local.name}-bundles-"
}

resource "aws_s3_bucket_public_access_block" "bundles" {
  bucket                  = aws_s3_bucket.bundles.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------- Elastic Beanstalk ----------------

resource "aws_cloudwatch_log_group" "app" {
  name              = local.app_log_group
  retention_in_days = 30
}

resource "aws_elastic_beanstalk_application" "api" {
  name = local.name
}

locals {
  eb_settings = [
    # networking
    { ns = "aws:ec2:vpc", name = "VPCId", value = var.vpc_id },
    { ns = "aws:ec2:vpc", name = "Subnets", value = join(",", var.private_subnet_ids) },
    { ns = "aws:ec2:vpc", name = "ELBSubnets", value = join(",", var.public_subnet_ids) },
    { ns = "aws:ec2:vpc", name = "AssociatePublicIpAddress", value = "false" },
    # instances
    { ns = "aws:autoscaling:launchconfiguration", name = "IamInstanceProfile", value = aws_iam_instance_profile.instance.name },
    { ns = "aws:autoscaling:launchconfiguration", name = "SecurityGroups", value = aws_security_group.app.id },
    { ns = "aws:autoscaling:launchconfiguration", name = "DisableIMDSv1", value = "true" },
    { ns = "aws:ec2:instances", name = "InstanceTypes", value = var.instance_type },
    { ns = "aws:autoscaling:asg", name = "MinSize", value = "2" },
    { ns = "aws:autoscaling:asg", name = "MaxSize", value = "4" },
    # load balancer
    { ns = "aws:elasticbeanstalk:environment", name = "EnvironmentType", value = "LoadBalanced" },
    { ns = "aws:elasticbeanstalk:environment", name = "LoadBalancerType", value = "application" },
    { ns = "aws:elasticbeanstalk:environment", name = "ServiceRole", value = aws_iam_role.service.arn },
    { ns = "aws:elasticbeanstalk:environment:process:default", name = "HealthCheckPath", value = "/readyz" },
    # give in-flight trade landing loops time to finish before an instance is removed
    { ns = "aws:elasticbeanstalk:environment:process:default", name = "DeregistrationTimeout", value = "90" },
    { ns = "aws:elbv2:listener:443", name = "Protocol", value = "HTTPS" },
    { ns = "aws:elbv2:listener:443", name = "SSLCertificateArns", value = var.certificate_arn },
    { ns = "aws:elbv2:listener:443", name = "SSLPolicy", value = "ELBSecurityPolicy-TLS13-1-2-2021-06" },
    # deploys: new instances are health-checked before traffic moves; failures roll back automatically
    { ns = "aws:elasticbeanstalk:command", name = "DeploymentPolicy", value = "Immutable" },
    { ns = "aws:elasticbeanstalk:healthreporting:system", name = "SystemType", value = "enhanced" },
    { ns = "aws:elasticbeanstalk:managedactions", name = "ManagedActionsEnabled", value = "true" },
    { ns = "aws:elasticbeanstalk:managedactions", name = "PreferredStartTime", value = "Sun:20:00" },
    { ns = "aws:elasticbeanstalk:managedactions:platformupdate", name = "UpdateLevel", value = "minor" },
    # logs -> CloudWatch (feeds the metric filters below)
    { ns = "aws:elasticbeanstalk:cloudwatch:logs", name = "StreamLogs", value = "true" },
    { ns = "aws:elasticbeanstalk:cloudwatch:logs", name = "RetentionInDays", value = "30" },
    { ns = "aws:elasticbeanstalk:cloudwatch:logs", name = "DeleteOnTerminate", value = "false" },
    # non-secret app config; secrets come from Secrets Manager at boot (src/secrets.ts)
    { ns = "aws:elasticbeanstalk:application:environment", name = "NODE_ENV", value = "production" },
    { ns = "aws:elasticbeanstalk:application:environment", name = "PORT", value = "8080" },
    { ns = "aws:elasticbeanstalk:application:environment", name = "AWS_REGION", value = var.region },
    { ns = "aws:elasticbeanstalk:application:environment", name = "AWS_SECRETS_ID", value = aws_secretsmanager_secret.app.name },
    { ns = "aws:elasticbeanstalk:application:environment", name = "DATABASE_SSL", value = "verify" },
    { ns = "aws:elasticbeanstalk:application:environment", name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" },
  ]
}

resource "aws_elastic_beanstalk_environment" "api" {
  name                = local.env_name
  application         = aws_elastic_beanstalk_application.api.name
  solution_stack_name = data.aws_elastic_beanstalk_solution_stack.node.name

  dynamic "setting" {
    for_each = local.eb_settings
    content {
      namespace = setting.value.ns
      name      = setting.value.name
      value     = setting.value.value
    }
  }

  depends_on = [aws_cloudwatch_log_group.app]

  lifecycle {
    ignore_changes = [version_label] # CI owns the deployed version
  }
}

data "aws_lb" "api" {
  arn = one(aws_elastic_beanstalk_environment.api.load_balancers)
}

# ---------------- Monitoring & alerts ----------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Metrics extracted from the app's structured JSON logs.
resource "aws_cloudwatch_log_metric_filter" "tx_expired" {
  name           = "tx-expired"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"trade_landed\" && $.status = \"expired\" }"
  metric_transformation {
    name      = "TxExpired"
    namespace = "SolanaTrade"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "tx_landed" {
  name           = "tx-landed"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"trade_landed\" }"
  metric_transformation {
    name      = "TxLanded"
    namespace = "SolanaTrade"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "sponsor_balance" {
  name           = "sponsor-balance"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.event = \"sponsor_balance\" }"
  metric_transformation {
    name      = "SponsorBalanceLamports"
    namespace = "SolanaTrade"
    value     = "$.lamports"
  }
}

resource "aws_cloudwatch_metric_alarm" "sponsor_low" {
  alarm_name          = "${local.name}-sponsor-balance-low"
  alarm_description   = "Gas sponsor wallet is running low. See RUNBOOK: 'Sponsor balance low'."
  namespace           = "SolanaTrade"
  metric_name         = "SponsorBalanceLamports"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = var.sponsor_low_balance_lamports
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "tx_expiry_rate" {
  alarm_name          = "${local.name}-tx-expiry-rate-high"
  alarm_description   = "More than 10% of trades expiring. See RUNBOOK: 'Transactions not landing'."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.1
  evaluation_periods  = 3
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "rate"
    expression  = "expired / MAX([landed, 1])"
    return_data = true
  }
  metric_query {
    id = "expired"
    metric {
      namespace   = "SolanaTrade"
      metric_name = "TxExpired"
      period      = 300
      stat        = "Sum"
    }
  }
  metric_query {
    id = "landed"
    metric {
      namespace   = "SolanaTrade"
      metric_name = "TxLanded"
      period      = 300
      stat        = "Sum"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = data.aws_lb.api.arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------------- Outputs (set these as GitHub repository variables for CI) ----------------

output "api_url" {
  value = "https://${aws_elastic_beanstalk_environment.api.cname}"
}

output "EB_APP_NAME" {
  value = aws_elastic_beanstalk_application.api.name
}

output "EB_ENV_NAME" {
  value = aws_elastic_beanstalk_environment.api.name
}

output "EB_BUNDLE_BUCKET" {
  value = aws_s3_bucket.bundles.bucket
}
