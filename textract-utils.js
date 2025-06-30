// AWS SDK v3 initialization
import { TextractClient, AnalyzeDocumentCommand, StartDocumentAnalysisCommand, GetDocumentAnalysisCommand } from '@aws-sdk/client-textract';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const textractClient = new TextractClient({});
const s3Client = new S3Client({});
const ddbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(ddbClient);

/**
 * Determines the number of pages in a document
 * First checks S3 metadata, then falls back to Textract analysis
 */
async function getPageCount(bucket, key) {
    console.log(`Getting page count for s3://${bucket}/${key}`);
    try {
        // Try to get page count from S3 metadata first
        const headCommand = new HeadObjectCommand({ Bucket: bucket, Key: key });
        const headData = await s3Client.send(headCommand);
        if (headData.Metadata?.['x-amz-meta-page-count']) {
            const pageCount = parseInt(headData.Metadata['x-amz-meta-page-count']);
            console.log(`Page count from S3 metadata: ${pageCount}`);
            return pageCount;
        }

        // Fallback: Use Textract to analyze document structure
        console.log('No page count in metadata, using Textract analysis');
        const analyzeCommand = new AnalyzeDocumentCommand({
            Document: {
                S3Object: {
                    Bucket: bucket,
                    Name: key
                }
            },
            FeatureTypes: ['LAYOUT']
        });

        const data = await textractClient.send(analyzeCommand);
        const pageCount = data.Blocks.filter(block => block.BlockType === 'PAGE').length;
        console.log(`Page count from Textract analysis: ${pageCount}`);
        return pageCount;
    } catch (error) {
        console.error('Error getting page count:', error);
        console.log('Defaulting to single page document');
        return 1;
    }
}

/**
 * Retrieves all company configuration records from DynamoDB
 * Contains field extraction rules for each company
 */
async function getAllCompanyRecords() {
    console.log('Fetching all company records from DynamoDB');
    try {
        const params = {
            TableName: process.env.COMPANY_FIELDS_TABLE,
            ProjectionExpression: 'company, fields, targetTables'
        };
        const command = new ScanCommand(params);
        const data = await dynamodb.send(command);
        const recordCount = data.Items?.length || 0;
        console.log(`Retrieved ${recordCount} company records`);
        return data.Items || [];
    } catch (error) {
        console.error('Failed to fetch company records:', error);
        throw error;
    }
}

/**
 * Starts asynchronous Textract document analysis for multi-page documents
 * Returns job ID for tracking the analysis progress
 */
async function startAsyncTextractJob(s3Location) {
    console.log(`Starting async Textract job for s3://${s3Location.bucket}/${s3Location.key}`);
    const command = new StartDocumentAnalysisCommand({
        DocumentLocation: {
            S3Object: {
                Bucket: s3Location.bucket,
                Name: s3Location.key
            }
        },
        FeatureTypes: ['FORMS', 'TABLES']
    });
    const response = await textractClient.send(command);
    console.log(`Async Textract job started with ID: ${response.JobId}`);
    return response.JobId;
}

/**
 * Retrieves results from an asynchronous Textract job
 * Handles pagination with nextToken for large documents
 */
async function getAsyncResults(jobId, nextToken) {
    console.log(`Getting async results for job: ${jobId}${nextToken ? ` with token: ${nextToken}` : ''}`);
    const params = { JobId: jobId };
    if (nextToken) params.NextToken = nextToken;
    const command = new GetDocumentAnalysisCommand(params);
    const response = await textractClient.send(command);
    console.log(`Job status: ${response.JobStatus}, Blocks received: ${response.Blocks?.length || 0}`);
    return response;
}

/**
 * Searches for company name matches within page text
 * Returns the first matching company record
 */
function findMatchingCompanyInPage(pageText, companyRecords) {
    console.log('Searching for company matches in page text');
    const normalizedText = pageText.toLowerCase();
    const matchedCompany = companyRecords.find(company => 
        normalizedText.includes(company.company.toLowerCase())
    );
    if (matchedCompany) {
        console.log(`Found matching company: ${matchedCompany.company}`);
    } else {
        console.log('No company match found in this page');
    }
    return matchedCompany;
}

/**
 * Extracts all text content from a specific page
 * Filters LINE blocks that belong to the given page
 */
function extractTextFromPage(blocks, pageId) {
    console.log(`Extracting text from page ID: ${pageId}`);
    const pageBlocks = blocks.filter(block => 
        block.BlockType === 'LINE' && 
        block.Relationships?.some(rel => 
            rel.Type === 'CHILD' && rel.Ids.includes(pageId)
        )
    );
    const extractedText = pageBlocks.map(block => block.Text).join('\n');
    console.log(`Extracted ${pageBlocks.length} text lines from page`);
    return extractedText;
}

/**
 * Extracts specific fields from a page using key-value pairs and pattern matching
 * Returns extracted field values for the given page
 */
function extractFieldsFromPage(blocks, pageId, fieldsToExtract) {
    console.log(`Extracting fields from page ${pageId}:`, fieldsToExtract);
    const pageBlocks = blocks.filter(block => 
        block.Page === pageId || 
        block.Relationships?.some(rel => rel.Ids.includes(pageId))
    );
    
    const keyValuePairs = extractKeyValuePairs(pageBlocks);
    const results = {};
    
    for (const field of fieldsToExtract) {
        results[field] = keyValuePairs[field] || extractFieldByPattern(pageBlocks, field);
        console.log(`Field '${field}': ${results[field] || 'not found'}`);
    }
    
    return results;
}

/**
 * Retrieves target database tables for a specific company
 * Used to determine where to store extracted data
 */
async function getTargetTablesForCompany(company) {
    console.log(`Getting target tables for company: ${company}`);
    try {
        const params = {
            TableName: process.env.COMPANY_FIELDS_TABLE,
            Key: { company },
            ProjectionExpression: 'targetTables'
        };
        const command = new GetCommand(params);
        const data = await dynamodb.send(command);
        const targetTables = data.Item?.targetTables || [];
        console.log(`Target tables for ${company}:`, targetTables);
        return targetTables;
    } catch (error) {
        console.error(`Error getting target tables for ${company}:`, error);
        return [];
    }
}

/**
 * Performs synchronous Textract analysis on a document
 * Used for single-page documents to extract forms and tables
 */
async function analyzeDocument(s3Location) {
    console.log(`Analyzing document: s3://${s3Location.bucket}/${s3Location.key}`);
    const command = new AnalyzeDocumentCommand({
        Document: {
            S3Object: {
                Bucket: s3Location.bucket,
                Name: s3Location.key
            }
        },
        FeatureTypes: ['FORMS', 'TABLES']
    });

    try {
        const data = await textractClient.send(command);
        console.log(`Document analysis completed. Blocks found: ${data.Blocks?.length || 0}`);
        return data;
    } catch (error) {
        console.error('Error in analyzeDocument:', error);
        throw error;
    }
}

/**
 * Extracts all text content from Textract blocks
 * Filters for LINE blocks and joins them with newlines
 */
function extractText(blocks) {
    const lineBlocks = blocks.filter(block => block.BlockType === 'LINE');
    console.log(`Extracting text from ${lineBlocks.length} line blocks`);
    return lineBlocks.map(block => block.Text).join('\n');
}

/**
 * Extracts key-value pairs from Textract form blocks
 * Maps keys to their corresponding values using block relationships
 */
function extractKeyValuePairs(blocks) {
    console.log('Extracting key-value pairs from blocks');
    const keyMap = {};
    const valueMap = {};
    const blockMap = {};

    // Organize blocks by type and create lookup maps
    for (const block of blocks) {
        blockMap[block.Id] = block;

        if (block.BlockType === 'KEY_VALUE_SET') {
            if (block.EntityTypes.includes('KEY')) {
                keyMap[block.Id] = block;
            } else {
                valueMap[block.Id] = block;
            }
        }
    }

    console.log(`Found ${Object.keys(keyMap).length} keys and ${Object.keys(valueMap).length} values`);

    // Match keys with their corresponding values
    const keyValues = {};
    for (const keyBlockId in keyMap) {
        const keyBlock = keyMap[keyBlockId];
        const keyText = getTextForBlock(keyBlock, blockMap);

        if (keyBlock.Relationships) {
            for (const rel of keyBlock.Relationships) {
                if (rel.Type === 'VALUE') {
                    for (const valueId of rel.Ids) {
                        const valueBlock = valueMap[valueId];
                        const valueText = getTextForBlock(valueBlock, blockMap);
                        keyValues[keyText] = valueText;
                        console.log(`Mapped key-value: '${keyText}' -> '${valueText}'`);
                    }
                }
            }
        }
    }

    return keyValues;
}

/**
 * Extracts text content from a block by traversing its child relationships
 * Handles both WORD blocks and SELECTION_ELEMENT blocks (checkboxes)
 */
function getTextForBlock(block, blockMap) {
    if (!block.Relationships) return '';
    const texts = [];

    for (const rel of block.Relationships) {
        if (rel.Type === 'CHILD') {
            for (const childId of rel.Ids) {
                const wordBlock = blockMap[childId];
                if (wordBlock.BlockType === 'WORD') {
                    texts.push(wordBlock.Text);
                } else if (wordBlock.BlockType === 'SELECTION_ELEMENT') {
                    // Handle checkboxes and selection elements
                    texts.push(wordBlock.SelectionStatus === 'SELECTED' ? '[X]' : '[ ]');
                }
            }
        }
    }

    return texts.join(' ');
}

/**
 * Extracts field values using pattern matching when key-value pairs fail
 * Searches for field names followed by common separators (: - =)
 */
function extractFieldByPattern(blocks, fieldName) {
    console.log(`Attempting pattern extraction for field: ${fieldName}`);
    const text = extractText(blocks).toLowerCase();
    const lines = text.split('\n');

    for (const line of lines) {
        if (line.includes(fieldName.toLowerCase())) {
            const parts = line.split(/:|-|=/);
            if (parts.length > 1) {
                const extractedValue = parts.slice(1).join(':').trim();
                console.log(`Pattern match found for '${fieldName}': ${extractedValue}`);
                return extractedValue;
            }
        }
    }
    console.log(`No pattern match found for field: ${fieldName}`);
    return null;
}

/**
 * Identifies the company from document text and returns associated field extraction rules
 * Searches document text for company name matches
 */
async function identifyCompanyAndFields(documentText) {
    console.log('Identifying company from document text');
    const companyRecords = await getAllCompanyRecords();
    const lowerText = documentText.toLowerCase();

    for (const record of companyRecords) {
        if (lowerText.includes(record.company.toLowerCase())) {
            console.log(`Company identified: ${record.company}`);
            console.log(`Fields to extract:`, record.fields);
            return {
                company: record.company,
                fieldsToExtract: record.fields
            };
        }
    }

    console.log('No company identified in document text');
    return {
        company: null,
        fieldsToExtract: []
    };
}

/**
 * Extracts specified fields from document blocks
 * Uses key-value pairs first, falls back to pattern matching
 */
function extractFields(blocks, fieldsToExtract) {
    console.log('Extracting fields:', fieldsToExtract);
    const keyValuePairs = extractKeyValuePairs(blocks);
    const results = {};
    
    for (const field of fieldsToExtract) {
        results[field] = keyValuePairs[field] || extractFieldByPattern(blocks, field);
        console.log(`Field '${field}' extracted: ${results[field] || 'not found'}`);
    }
    
    return results;
}

/**
 * Processes a single-page document using synchronous Textract analysis
 * Identifies company, extracts fields, and prepares results for storage
 */
async function processSinglePageDocument(s3Location) {
    console.log('=== Processing single page document ===');
    
    // Analyze document with Textract
    const textractData = await analyzeDocument(s3Location);
    const documentText = extractText(textractData.Blocks);
    console.log(`Document text length: ${documentText.length} characters`);
    
    // Identify company and get field extraction rules
    const { company, fieldsToExtract } = await identifyCompanyAndFields(documentText);
    if (!company) {
        console.error('Company identification failed');
        throw new Error('Company not recognized in single page document');
    }

    // Extract specified fields
    const extractionResults = extractFields(textractData.Blocks, fieldsToExtract);
    console.log('Field extraction completed for single page');
    
    const result = [{
        company,
        pageNumber: 1,
        extractedFields: extractionResults,
        targetTables: await getTargetTablesForCompany(company)
    }];
    
    console.log('Single page processing completed successfully');
    return result;
}

/**
 * Processes a multi-page document using asynchronous Textract analysis
 * Handles pagination and processes each page individually
 */
async function processMultiPageDocument(s3Location, companyRecords) {
    console.log('=== Processing multi-page document ===');
    const results = [];
    
    // Start asynchronous Textract job
    const jobId = await startAsyncTextractJob(s3Location);

    let nextToken = null;
    let currentPage = 1;
    let finished = false;
    
    // Process results in batches (pagination)
    while (!finished) {
        const response = await getAsyncResults(jobId, nextToken);
        
        // Process each page in the current batch
        const pageBlocks = response.Blocks.filter(block => block.BlockType === 'PAGE');
        console.log(`Processing ${pageBlocks.length} pages in current batch`);
        
        for (const pageBlock of pageBlocks) {
            console.log(`--- Processing page ${currentPage} ---`);
            const pageText = extractTextFromPage(response.Blocks, pageBlock.Id);
            
            // Find matching company for this page
            const matchedCompany = findMatchingCompanyInPage(pageText, companyRecords);
            if (matchedCompany) {
                console.log(`Processing page ${currentPage} for company: ${matchedCompany.company}`);
                const fieldsToExtract = matchedCompany.fields;
                const extractedFields = extractFieldsFromPage(response.Blocks, pageBlock.Id, fieldsToExtract);
                
                results.push({
                    company: matchedCompany.company,
                    pageNumber: currentPage,
                    extractedFields,
                    targetTables: matchedCompany.targetTables || []
                });
                console.log(`Page ${currentPage} processed successfully`);
            } else {
                console.log(`No company match found for page ${currentPage}`);
            }

            currentPage++;
        }

        // Check if processing is complete
        if (!response.NextToken || response.JobStatus !== 'IN_PROGRESS') {
            finished = true;
            console.log('Multi-page processing completed');
        } else {
            nextToken = response.NextToken;
            console.log('Continuing to next batch of pages');
        }
    }

    console.log(`Multi-page processing completed. Total results: ${results.length}`);
    return results;
}

/**
 * Stores extraction results in the appropriate DynamoDB tables
 * Each company can have multiple target tables for data storage
 */
async function storeResultsInTables(results, s3Location) {
    console.log('=== Storing results in DynamoDB tables ===');
    
    for (const result of results) {
        console.log(`Storing results for company: ${result.company}, page: ${result.pageNumber}`);
        
        if (!result.targetTables || result.targetTables.length === 0) {
            console.warn(`No target tables specified for company ${result.company}`);
            continue;
        }

        // Store in each target table for this company
        for (const tableName of result.targetTables) {
            try {
                const documentId = `${s3Location.bucket}-${s3Location.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const params = {
                    TableName: tableName,
                    Item: {
                        documentId,
                        company: result.company,
                        pageNumber: result.pageNumber,
                        extractedFields: result.extractedFields,
                        processedAt: new Date().toISOString()
                    }
                };
                
                console.log(`Storing in table: ${tableName}`);
                const command = new PutCommand(params);
                await dynamodb.send(command);
                console.log(`✓ Successfully stored results in table ${tableName} for page ${result.pageNumber}`);
            } catch (error) {
                console.error(`✗ Error storing results in table ${tableName}:`, error);
            }
        }
    }
    
    console.log('Results storage completed');
}

export {
    getPageCount,
    getAllCompanyRecords,
    startAsyncTextractJob,
    getAsyncResults,
    findMatchingCompanyInPage,
    extractTextFromPage,
    extractFieldsFromPage,
    getTargetTablesForCompany,
    analyzeDocument,
    extractText,
    extractKeyValuePairs,
    getTextForBlock,
    extractFieldByPattern,
    identifyCompanyAndFields,
    extractFields,
    processSinglePageDocument,
    processMultiPageDocument,
    storeResultsInTables
};


// Main Table (Company Configurations): COMPANY_FIELDS_TABLE

// Attribute    Type    Description     Key
// company      String  Primary key - exact company name        Partition
// fields       List    Default fields to extract       
// targetTables List    DynamoDB table names where data should be stored



// Example Target Tables Structure:
// Each target table can have its own schema, but should at minimum support:

// documentId (String) - Unique identifier for the document

// company (String) - Company name

// pageNumber (Number) - Page number (for multi-page docs)

// extractedFields (Map) - Key-value pairs of extracted data

// processedAt (String) - ISO timestamp of processing