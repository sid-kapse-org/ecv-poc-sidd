import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const textractClient = new TextractClient({});

export const handler = async (filePath = 'test.pdf') => {
    try {
        if (!filePath) {
            throw new Error('File path is required');
        }

        console.log('Processing file:', filePath);
        
        // Ensure file exists in root folder
        const fullPath = path.join(process.cwd(), filePath);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // Read file from root folder
        const fileBuffer = fs.readFileSync(fullPath);
        
        // Validate file is not empty
        if (fileBuffer.length === 0) {
            throw new Error('File is empty');
        }
        
        const params = {
            Document: {
                Bytes: fileBuffer
            },
            FeatureTypes: ['TABLES'] // Specify the features we want to analyze
        };

        // Analyze the document with Textract
        const command = new AnalyzeDocumentCommand(params);
        const data = await textractClient.send(command);
        // write the data to json file
        const outputFilePath = path.join(process.cwd(), 'textract_output.json');
        fs.writeFileSync(outputFilePath, JSON.stringify(data, null, 2));
        //console.log('Textract Response:', JSON.stringify(data));

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

// Execute if this file is run directly from Node.js
async function processDocument(filePath) {
    console.log(`Processing ${filePath || 'test.pdf'} from root folder...`);
    try {
        const result = await handler(filePath);
        console.log('Processing completed successfully:');
        console.log(result);
    } catch (error) {
        console.error('Processing failed:', error);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const filePath = process.argv[2]; // Get file path from command line argument
    processDocument(filePath);
}
