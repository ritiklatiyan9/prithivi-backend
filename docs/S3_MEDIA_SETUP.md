# Private S3 media storage

The API stores optimized images in a private S3 bucket when `AWS_S3_BUCKET` is configured. The bucket remains behind S3 Block Public Access. App, web, and admin clients keep a stable application URL; the API validates its random capability token and redirects to a five-minute S3 URL.

## Create the bucket

Deploy `infra/s3-media.yaml` in the same AWS region as the API when possible:

```bash
aws cloudformation deploy \
  --stack-name money-marathon-media \
  --template-file infra/s3-media.yaml \
  --parameter-overrides BucketName=YOUR_GLOBALLY_UNIQUE_BUCKET \
  --capabilities CAPABILITY_NAMED_IAM
```

Attach the output `BackendPolicyArn` to the IAM role or user used by the API host. Prefer an IAM role. If the host cannot assume a role, store `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` only in its encrypted secret manager.

Set these API environment variables:

```text
AWS_S3_BUCKET=YOUR_GLOBALLY_UNIQUE_BUCKET
AWS_S3_REGION=ap-south-1
AWS_S3_KEY_PREFIX=money-marathon
AWS_S3_SIGNED_URL_SECONDS=300
```

`CLOUDINARY_URL` and local disk remain development/transition fallbacks only when `AWS_S3_BUCKET` is absent. Never make the proof bucket public and do not add browser CORS rules; uploads travel through the authenticated API.

## Recover old local proof files

After the database migration and S3 configuration are active, run this once from the machine holding the old `uploads/` directory. Set `APP_URL` to the deployed API origin so rewritten database links are canonical:

```bash
APP_URL=https://prithivi-backend.onrender.com npm run media:migrate-local-proofs
```

The tool migrates only files it can match to a proof record. It prints counts and leaves missing files unchanged so an administrator can request replacement proof instead of silently changing evidence.
