# AWS SAM Textract Document Processing Application

This application uses AWS Serverless Application Model (SAM) to deploy a document processing pipeline that leverages Amazon Textract for extracting information from documents.

## Architecture

The application consists of:

- Lambda function triggered by S3 uploads
- S3 bucket for document storage
- DynamoDB table for company configurations
- IAM roles and policies for secure access

## Prerequisites

- AWS CLI installed and configured
- AWS SAM CLI installed
- Node.js 18.x or later
- An AWS account with appropriate permissions

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd <repository-name>
```

2. Install dependencies:
```bash
npm install
```

3. Build the SAM application:
```bash
npm run build
```

4. Deploy the application:
```bash
npm run deploy
```

During the first deployment, you'll be prompted to:
- Choose a stack name
- Choose an AWS Region
- Allow SAM CLI to create IAM roles
- Save the configuration for future deployments

## Usage

1. Upload a document to the created S3 bucket:
```bash
aws s3 cp <your-document.pdf> s3://<stack-name>-documents/
```

2. The Lambda function will automatically:
- Analyze the document using Amazon Textract
- Extract relevant information based on company configurations
- Store results in DynamoDB tables

3. Monitor the process through CloudWatch logs

## Configuration

### Company Fields Table Structure

The DynamoDB table stores company-specific processing configurations:

- `company` (String) - Primary key, company name
- `fields` (List) - Fields to extract from documents
- `targetTables` (List) - DynamoDB tables for storing results

### Environment Variables

- `COMPANY_FIELDS_TABLE` - DynamoDB table name for company configurations

## Development

### Local Testing

Test the Lambda function locally:
```bash
npm run invoke-local
```

### Running API Locally

Start a local API endpoint:
```bash
npm run start-local
```

## Project Structure

- `index.js` - Main Lambda handler
- `textract-utils.js` - Utility functions for document processing
- `template.yaml` - SAM template defining infrastructure
- `package.json` - Project dependencies and scripts

## License

ISC