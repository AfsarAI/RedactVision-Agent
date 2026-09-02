# Deploying RedactVision Server to AWS

This guide explains how to build the Docker container for the **RedactVision Reasoning Server** and deploy it to **AWS**.

---

## 🏛 Architecture Overview

- **Server (`server/`)**: FastAPI reasoning gateway with LLM multi-provider fallback (Groq, OpenRouter, OmniRoute). This is containerized and deployed on AWS.
- **Extension (`extension/`)**: Client-side browser extension that runs locally in Google Chrome / Brave / Edge. It performs client-side DOM perception, tokenization, and privacy redaction. **It is excluded from the Docker build** via `.dockerignore` because it is loaded into the user's browser, not hosted on AWS backend containers.

```text
┌───────────────────────────────────────┐
│     User's Browser (Chrome/Edge)      │
│  [RedactVision Browser Extension]     │
│  - DOM Sanitization                   │
│  - Local Token Mapping (never leaves) │
└──────────────────┬────────────────────┘
                   │ HTTPS / WSS
                   ▼
┌───────────────────────────────────────┐
│              AWS CLOUD                │
│  [AWS App Runner / ECS Fargate]       │
│  Docker Container (Port 8001)         │
│  - /health                            │
│  - /llm/plan                          │
│  - /llm/plan-smart                    │
│  - /ws/agent                          │
└───────────────────────────────────────┘
```

---

## 🐳 Docker Container Quick Reference

### 1. Build and Test Locally

To test the container before publishing to AWS:

```bash
# Build the Docker image
docker build -t redactvision-server:latest .

# Run with your local .env file
docker run --rm -it \
  -p 8001:8001 \
  --env-file .env \
  redactvision-server:latest
```

Or using **Docker Compose**:

```bash
docker compose up --build
```

Verify health check:
```bash
curl http://localhost:8001/health
# Response: {"status":"healthy","timestamp":...,"connections":0}
```

---

## 🚀 Deployment Option 1: AWS App Runner (Recommended)

AWS App Runner is the fastest, simplest way to deploy containerized FastAPI applications. It provides built-in HTTPS, automated certificate renewal, health checks, and automatic scaling.

### Step 1: Create Amazon ECR Repository and Push Image

```bash
# Set your variables
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="redactvision-server"

# 1. Create ECR repository (if not already created)
aws ecr create-repository \
  --repository-name $ECR_REPO \
  --region $AWS_REGION

# 2. Authenticate Docker with Amazon ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# 3. Build image for amd64 architecture (compatible with AWS standard instances)
docker buildx build --platform linux/amd64 -t $ECR_REPO:latest .

# 4. Tag and push to ECR
docker tag $ECR_REPO:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
```

### Step 2: Create App Runner Service

In the AWS Console or via AWS CLI:

1. Go to **AWS App Runner** > **Create Service**.
2. **Source**: Container registry > **Amazon ECR**.
3. **Image URI**: Select `redactvision-server:latest`.
4. **Deployment settings**: Choose **Automatic** or **Manual**.
5. **Configure service**:
   - **Port**: `8001`
   - **Environment variables**:
     - `GROQ_API_KEY`: `gsk_...`
     - `OPENROUTER_API_KEY`: `sk-or-v1-...`
     - `CORS_ORIGINS`: `*` (or restrict to your specific domains)
     - `HOST`: `0.0.0.0`
     - `PORT`: `8001`
   - **Health check**:
     - Protocol: `HTTP`
     - Path: `/health`
     - Interval: `10`
     - Timeout: `5`
6. Click **Create & Deploy**.
7. Once deployed, App Runner outputs a default HTTPS URL:
   `https://<random-id>.<region>.awsapprunner.com`

---

## 🚢 Deployment Option 2: AWS ECS Fargate

For production architectures using AWS VPCs, Application Load Balancers (ALB), or AWS Secrets Manager:

### 1. Push Image to ECR
Follow Step 1 above to push the container to ECR.

### 2. Store Secrets in AWS Secrets Manager
```bash
aws secretsmanager create-secret \
  --name redactvision/groq-key \
  --secret-string "gsk_your_groq_api_key" \
  --region $AWS_REGION

aws secretsmanager create-secret \
  --name redactvision/openrouter-key \
  --secret-string "sk-or-v1-your_openrouter_api_key" \
  --region $AWS_REGION
```

### 3. Register Task Definition
Review `aws/task-definition.json`, update `<AWS_ACCOUNT_ID>` and `<AWS_REGION>`, then run:

```bash
aws ecs register-task-definition \
  --cli-input-json file://aws/task-definition.json \
  --region $AWS_REGION
```

### 4. Create ECS Service with ALB
1. Create an ECS Cluster.
2. Create an Application Load Balancer (ALB) listening on Port 443 (HTTPS) and forwarding to Target Group on Port 8001 (Health check path: `/health`).
3. Deploy the ECS Service with launch type `FARGATE`.

---

## ⚙️ Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8001` | Port uvicorn listens on inside the container |
| `HOST` | `0.0.0.0` | Bind address (must be `0.0.0.0` for containers) |
| `ENVIRONMENT` | `production` | Deployment environment |
| `RELOAD` | `false` | Disable auto-reloading in production |
| `CORS_ORIGINS` | `*` | Allowed origins (supports comma-separated list or `*`) |
| `GROQ_API_KEY` | *(Required)* | Groq API Key for primary high-speed reasoning |
| `OPENROUTER_API_KEY` | *(Optional)* | Secondary fallback provider |
| `OMNIROUTE_URL` | *(Optional)* | Tertiary local/custom LLM endpoint |
| `LLM_TIMEOUT_SECONDS` | `30` | Max timeout per provider call |
| `LLM_RETRIES_PER_PROVIDER` | `1` | Retries on rate limits before fallback |

---

## 🔌 Connecting the Chrome Extension to AWS

Once your server is live on AWS (e.g. `https://api.my-redactvision.awsapprunner.com`):

1. Open Chrome and click the **RedactVision Extension** icon in your toolbar.
2. Click **Server Settings** (or open the extension options).
3. Set **Server URL** to your AWS URL:
   ```text
   https://<your-service-url>.awsapprunner.com
   ```
4. Click **Test Connection**. It should display:
   ```text
   ✓ Connected (status: healthy)
   ```
5. All reasoning plans will now execute via your cloud-hosted AWS container!
