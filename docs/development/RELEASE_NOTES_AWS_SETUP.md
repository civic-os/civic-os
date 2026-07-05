# LLM-Generated Release Notes — AWS Setup Guide

The CI/CD pipeline generates release notes using Claude Sonnet via AWS Bedrock, authenticated through OIDC federation (zero stored secrets). This document covers the one-time AWS setup.

## Architecture

```
GitHub Actions (tag push)
  └─ Mints OIDC JWT (ephemeral, per-run)
       └─ AWS STS AssumeRoleWithWebIdentity
            └─ 15-minute temp credentials
                 └─ bedrock:InvokeModel (Claude Sonnet, us-east-1)
                      └─ Release notes → GitHub Release
```

**Fallback**: If AWS credentials fail (misconfigured role, missing secret, Bedrock error), the workflow falls back to a commit-list bullet format. Releases are never blocked.

## Prerequisites

- AWS account with Bedrock access in `us-east-1`
- AWS CLI or Console access with IAM permissions
- GitHub repository admin access (for secrets)

## Step 1: Create OIDC Identity Provider

If your AWS account doesn't already have a GitHub Actions OIDC provider:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

> **Note**: The thumbprint is for GitHub's OIDC provider certificate. AWS may auto-verify this — check the [GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) for the latest value.

## Step 2: Create IAM Role

Create the role `civic-os-release-notes` with a trust policy scoped to tag pushes on this repository:

```bash
aws iam create-role \
  --role-name civic-os-release-notes \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
        },
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
          "StringEquals": {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
          },
          "StringLike": {
            "token.actions.githubusercontent.com:sub": "repo:civic-os/civic-os:ref:refs/tags/v*"
          }
        }
      }
    ]
  }'
```

**Security notes:**
- `StringLike` with `refs/tags/v*` means only version tag pushes can assume this role — not PRs, not branches, not forks
- Replace `YOUR_ACCOUNT_ID` with your 12-digit AWS account ID
- Replace `civic-os/civic-os` with your actual `owner/repo` if different

## Step 3: Attach Permission Policy

Create and attach an inline policy that allows invoking Sonnet models via inference profiles:

```bash
aws iam put-role-policy \
  --role-name civic-os-release-notes \
  --policy-name bedrock-invoke-sonnet \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "bedrock:InvokeModel",
        "Resource": [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-*",
          "arn:aws:bedrock:*:YOUR_ACCOUNT_ID:inference-profile/us.anthropic.claude-sonnet-*"
        ]
      }
    ]
  }'
```

> **Note**: Replace `YOUR_ACCOUNT_ID` with your 12-digit AWS account ID. The region is wildcarded (`*`) because cross-region inference profiles (`us.` prefix) route requests to any US region (us-east-1, us-east-2, us-west-2), and IAM checks evaluate against the destination region's ARN. The policy covers both foundation model and inference profile ARN formats.

**Blast radius**: Even if credentials leaked (impossible with OIDC, but hypothetically), the attacker can only call `InvokeModel` on this one model. No other AWS services, no S3, no EC2, no IAM changes.

## Step 4: Enable Bedrock Model Access

In the AWS Console:

1. Navigate to **Amazon Bedrock** → **Model access** (us-east-1 region)
2. Click **Manage model access**
3. Enable **Anthropic** → **Claude Sonnet 5** (`anthropic.claude-sonnet-*`)
4. Submit the access request (usually approved instantly)

> **Model updates**: When Anthropic releases new Sonnet versions, update both the IAM policy resource ARN and the `--model-id` in `.github/workflows/build-containers.yml`.

## Step 5: Add GitHub Secret

Add one secret to the repository:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Create secret: `AWS_ACCOUNT_ID` = your 12-digit AWS account ID

This is the only secret needed. The OIDC flow handles authentication without stored credentials.

## Cost Estimate

Each release invokes one Bedrock call with ~30-50K input tokens and ~500 output tokens:

| Component | Cost |
|-----------|------|
| Input tokens (~40K) | ~$0.12 |
| Output tokens (~500) | ~$0.02 |
| **Total per release** | **~$0.14** |

At one release per week, annual cost is approximately **$7**.

## Verification

### Test the full pipeline

Push a prerelease tag:

```bash
git tag v0.99.0-rc.1
git push origin v0.99.0-rc.1
```

Check the GitHub Actions run — the "Generate LLM release notes" step should succeed and the release should contain categorized notes.

### Test the fallback

Temporarily set `AWS_ACCOUNT_ID` to an invalid value (e.g., `000000000000`). Push another tag. The AWS credentials step should fail with `continue-on-error`, and the release should contain a simple commit bullet list.

### Verify IAM scoping

Confirm the role can only be assumed from tag pushes:

```bash
# This should show the trust policy with refs/tags/v* condition
aws iam get-role --role-name civic-os-release-notes \
  --query 'Role.AssumeRolePolicyDocument'
```

## Troubleshooting

**"Could not assume role"**: Check that `AWS_ACCOUNT_ID` secret is set and the OIDC provider exists in your account.

**"Access denied on InvokeModel"**: Ensure model access is enabled in Bedrock console (Step 4) and the IAM policy resource ARN matches the model ID.

**"Empty LLM response"**: Check the Bedrock response in the workflow logs. The model may have been throttled — Bedrock has per-account rate limits for on-demand inference.

**Model version changes**: If the model ID changes (new Sonnet version), update both:
1. `.github/workflows/build-containers.yml` — `--model-id` parameter
2. IAM policy — `Resource` ARN
