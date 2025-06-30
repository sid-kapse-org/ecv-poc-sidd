// Import utility functions for document processing
import {
    getPageCount,
    getAllCompanyRecords,
    processSinglePageDocument,
    processMultiPageDocument
} from './textract-utils.js';

/**
 * AWS Lambda handler for enhanced Textract document processing
 * Processes documents from S3, extracts company-specific fields, and stores results in DynamoDB
 * 
 * Event structure: S3 event notification with document upload details
 * Returns: Success/error response with processing results
 */
export const handler = async (event) => {
    console.log('=== TEXTRACT ENHANCED PROCESSING STARTED ===');
    console.log('Processing event:', JSON.stringify(event, null, 2));
    
    let s3Location;
    try {
        // Extract S3 location from the incoming event
        s3Location = {
            bucket: event.Records[0].s3.bucket.name,
            key: decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '))
        };
        console.log(`📄 Processing document: s3://${s3Location.bucket}/${s3Location.key}`);

        // Step 1: Determine document type (single vs multi-page)
        console.log('\n--- Step 1: Analyzing document structure ---');
        const pageCount = await getPageCount(s3Location.bucket, s3Location.key);
        const isMultiPage = pageCount > 1;
        console.log(`📊 Document analysis: ${pageCount} page(s) detected`);
        console.log(`🔄 Processing mode: ${isMultiPage ? 'Multi-page (Async)' : 'Single-page (Sync)'}`);

        // Step 2: Load company configuration for multi-page documents
        let companyRecords = [];
        if (isMultiPage) {
            console.log('\n--- Step 2: Loading company configurations ---');
            companyRecords = await getAllCompanyRecords();
            console.log(`📋 Loaded ${companyRecords.length} company configurations for processing`);
        } else {
            console.log('\n--- Step 2: Skipping company pre-load (single page) ---');
        }

        // Step 3: Process document based on page count
        console.log('\n--- Step 3: Document processing ---');
        let processingResults;
        if (isMultiPage) {
            console.log('🔄 Starting multi-page processing...');
            processingResults = await processMultiPageDocument(s3Location, companyRecords);
        } else {
            console.log('🔄 Starting single-page processing...');
            processingResults = await processSinglePageDocument(s3Location);
        }
        console.log(`✅ Processing completed. Results generated: ${processingResults.length}`);

        // Return success response
        const response = {
            statusCode: 200,
            body: JSON.stringify({
                status: 'SUCCESS',
                pageCount,
                resultsCount: processingResults.length,
                results: processingResults
            })
        };
        
        console.log('\n=== PROCESSING COMPLETED SUCCESSFULLY ===');
        console.log('Final response:', JSON.stringify(response, null, 2));
        return response;

    } catch (error) {
        console.error('\n❌ === PROCESSING FAILED ===');
        console.error('Error details:', error);
        console.error('Stack trace:', error.stack);
        
        const errorResponse = {
            statusCode: 500,
            body: JSON.stringify({
                status: 'ERROR',
                message: 'Document processing failed',
                error: error.message,
                document: s3Location ? `s3://${s3Location.bucket}/${s3Location.key}` : 'unknown'
            })
        };
        
        console.log('Error response:', JSON.stringify(errorResponse, null, 2));
        return errorResponse;
    }
};
