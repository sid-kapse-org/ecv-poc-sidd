import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';
import { S3Client } from '@aws-sdk/client-s3';

const textractClient = new TextractClient({});
const s3Client = new S3Client({});

export const handler = async (event) => {
    try {
        console.log('Event:', JSON.stringify(event));
        // Get the PDF file from S3
        const bucket = event.Records[0].s3.bucket.name;
        const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

        console.log('Bucket:', bucket);
        console.log('Key:', key);
        
        const params = {
            Document: {
                S3Object: {
                    Bucket: bucket,
                    Name: key
                }
            },
            FeatureTypes: ['FORMS']
        };

        // Analyze the document with Textract
        const command = new AnalyzeDocumentCommand(params);
        const data = await textractClient.send(command);
        
        // Process the blocks to find our target fields
        const result = {
            orderNumber: '',
            deliverTo: '',
            date: ''
        };
        
        // Find key-value pairs
        const keyValuePairs = extractKeyValuePairs(data.Blocks);
        console.log('Key-Value Pairs:', keyValuePairs);
        
        // Extract the values we need
        if (keyValuePairs['Your Order No']) {
            result.orderNumber = keyValuePairs['Your Order No'];
        }
        
        if (keyValuePairs['Deliver to:']) {
            result.deliverTo = keyValuePairs['Deliver to:'];
        }
        
        if (keyValuePairs['Date:']) {
            result.date = keyValuePairs['Date:'];
        }
        
        // If not found in key-value pairs, try alternative approach
        if (!result.orderNumber || !result.deliverTo || !result.date) {
            const text = extractText(data.Blocks);
            
            if (!result.orderNumber) {
                const orderMatch = text.match(/Your Order No\s*([^\n]+)/);
                if (orderMatch) result.orderNumber = orderMatch[1].trim();
            }
            
            if (!result.deliverTo) {
                const deliverMatch = text.match(/Deliver to:\s*([^\n]+)/);
                if (deliverMatch) result.deliverTo = deliverMatch[1].trim();
            }
            
            if (!result.date) {
                const dateMatch = text.match(/Date:\s*([0-9\/]+)/);
                if (dateMatch) result.date = dateMatch[1].trim();
            }
        }

        console.log('Extracted Result:', result);
        
        return {
            statusCode: 200,
            body: JSON.stringify(result)
        };
        
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({error: error.message})
        };
    }
};

// Helper function to extract key-value pairs from Textract blocks
function extractKeyValuePairs(blocks) {
    const keyValuePairs = {};
    const keyMap = {};
    const valueMap = {};
    const blockMap = {};
    
    // First, map blocks by ID and find key and value blocks
    blocks.forEach(block => {
        blockMap[block.Id] = block;
        
        if (block.BlockType === 'KEY_VALUE_SET') {
            if (block.EntityTypes.includes('KEY')) {
                keyMap[block.Id] = block;
            } else {
                valueMap[block.Id] = block;
            }
        }
    });
    
    // Then, find the corresponding value for each key
    Object.keys(keyMap).forEach(keyBlockId => {
        const keyBlock = keyMap[keyBlockId];
        const valueBlockId = keyBlock.Relationships.find(r => r.Type === 'VALUE').Ids[0];
        
        if (valueMap[valueBlockId]) {
            const keyText = getText(keyBlock, blockMap);
            const valueText = getText(valueMap[valueBlockId], blockMap);
            
            if (keyText && valueText) {
                keyValuePairs[keyText.trim()] = valueText.trim();
            }
        }
    });
    
    return keyValuePairs;
}

// Helper function to get text from a block
function getText(block, blockMap) {
    let text = '';
    
    if (block.Relationships) {
        block.Relationships.forEach(relationship => {
            if (relationship.Type === 'CHILD') {
                relationship.Ids.forEach(childId => {
                    const child = blockMap[childId];
                    if (child.BlockType === 'WORD') {
                        text += child.Text + ' ';
                    }
                });
            }
        });
    }
    
    return text.trim();
}

// Helper function to extract all text (fallback method)
function extractText(blocks) {
    let text = '';
    
    blocks.forEach(block => {
        if (block.BlockType === 'LINE') {
            text += block.Text + '\n';
        }
    });
    
    return text;
}