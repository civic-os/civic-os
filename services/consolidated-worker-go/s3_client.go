package main

import (
	"context"
	"log"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Clients holds both the S3 client and presign client
type S3Clients struct {
	S3Client        *s3.Client
	S3PresignClient *s3.PresignClient
}

// initializeS3Client creates AWS S3 clients with optional custom endpoint for presigning.
// Used by both S3PresignWorker (to generate presigned URLs) and ThumbnailWorker (to upload/download files).
//
// Parameters from environment:
//   - S3_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID (deprecated)
//   - S3_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY (deprecated)
//   - S3_REGION / AWS_REGION (deprecated)
//   - S3_ENDPOINT / AWS_ENDPOINT_URL (deprecated) - Internal endpoint for operations
//   - S3_PUBLIC_ENDPOINT - Public endpoint for presigned URLs (optional, for MinIO/Docker)
func initializeS3Client(ctx context.Context) *S3Clients {
	// S3 configuration with dual support (generic S3_* names take priority)
	s3AccessKey := getS3Env("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "")
	s3SecretKey := getS3Env("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "")
	s3Region := getS3Env("S3_REGION", "AWS_REGION", "us-east-1")
	s3Endpoint := getS3Env("S3_ENDPOINT", "AWS_ENDPOINT_URL", "")
	publicEndpoint := getEnv("S3_PUBLIC_ENDPOINT", "")

	log.Printf("[S3] Initializing S3 client...")
	log.Printf("[S3] Region: %s", s3Region)
	if s3Endpoint != "" {
		log.Printf("[S3] Internal Endpoint: %s", s3Endpoint)
	}
	if publicEndpoint != "" {
		log.Printf("[S3] Public Endpoint (presigning): %s", publicEndpoint)
	}

	// Initialize AWS S3 client with explicit credentials
	awsCfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			s3AccessKey,
			s3SecretKey,
			"", // session token (not used)
		)),
	)
	if err != nil {
		log.Fatalf("[S3] Failed to load AWS SDK configuration: %v", err)
	}

	// Configure S3 client with custom endpoint (if provided) and path-style URLs
	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if s3Endpoint != "" {
			o.BaseEndpoint = aws.String(s3Endpoint)
		}
		o.UsePathStyle = true // Required for MinIO and DigitalOcean Spaces
	})

	// For presigning, use public endpoint if configured (for local MinIO/Docker)
	var s3PresignClient *s3.PresignClient
	if publicEndpoint != "" {
		// Create separate config with public endpoint for presigned URLs
		publicCfg, err := config.LoadDefaultConfig(ctx,
			config.WithRegion(s3Region),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				s3AccessKey,
				s3SecretKey,
				"",
			)),
		)
		if err != nil {
			log.Fatalf("[S3] Failed to load AWS SDK configuration for presigning: %v", err)
		}

		publicS3Client := s3.NewFromConfig(publicCfg, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(publicEndpoint)
			o.UsePathStyle = true // Required for MinIO path-style URLs
		})
		s3PresignClient = s3.NewPresignClient(publicS3Client)
		log.Println("[S3] ✓ S3 client initialized with public endpoint for presigning")
	} else {
		s3PresignClient = s3.NewPresignClient(s3Client)
		log.Println("[S3] ✓ S3 client initialized")
	}

	return &S3Clients{
		S3Client:        s3Client,
		S3PresignClient: s3PresignClient,
	}
}

// getS3Env retrieves S3-related environment variable with dual support for generic and AWS-specific names.
// Priority: Generic S3_* names first, fallback to AWS_* names with deprecation warning.
// This maintains backward compatibility while migrating to vendor-neutral naming.
func getS3Env(genericKey, awsKey, defaultValue string) string {
	// Try generic S3_* name first (preferred)
	if value := getEnv(genericKey, ""); value != "" {
		return value
	}

	// Fallback to AWS-specific name (deprecated)
	if value := getEnv(awsKey, ""); value != "" {
		log.Printf("⚠️  WARNING: %s is deprecated, use %s instead (AWS-specific naming will be removed in v1.0.0)", awsKey, genericKey)
		return value
	}

	return defaultValue
}
