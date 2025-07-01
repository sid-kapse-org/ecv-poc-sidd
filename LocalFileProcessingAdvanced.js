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
            FeatureTypes: ['FORMS', 'TABLES']
        };

        // Analyze the document with Textract
        const command = new AnalyzeDocumentCommand(params);
        const data = await textractClient.send(command);
        // write the data to json file
        writeJsonToFile(data, 'textract_output.json');      //console.log('Textract Response:', JSON.stringify(data));

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
        
        // Extract table data
        const tableData = extractTableData(data.Blocks);
        
        // Prepare response
        const response = {
            result,
            items: tableData
        };

        return {
            statusCode: 200,
            body: JSON.stringify({
                response
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};


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

function extractTableData(blocks) {
    // Find all LINE blocks that represent table headers
    const headers = [
        { text: 'Item No.', key: 'itemNo' },
        { text: 'Quantity', key: 'quantity' },
        { text: 'Descriptions', key: 'description' },
        { text: 'Unit Price', key: 'unitPrice' },
        { text: 'Amount', key: 'amount' }
    ];
    
    // Find the bounding box of the headers to determine table region
    const headerBlocks = headers.map(header => 
        blocks.find(block => 
            block.BlockType === 'LINE' && 
            block.Text === header.text
        )
    ).filter(Boolean);
    
    if (headerBlocks.length === 0) return [];
    
    // Get the approximate vertical position of the table
    const tableTop = Math.min(...headerBlocks.map(h => h.Geometry.BoundingBox.Top));
    const tableBottom = 0.9; // Assuming table doesn't go beyond 90% of page
    
    // Find all LINE blocks in the table region
    const tableLines = blocks.filter(block => 
        block.BlockType === 'LINE' &&
        block.Geometry.BoundingBox.Top > tableTop &&
        block.Geometry.BoundingBox.Top < tableBottom
    );
    
    // Group lines by their vertical position (assuming items are horizontally aligned)
    const lineGroups = {};
    tableLines.forEach(line => {
        const y = Math.round(line.Geometry.BoundingBox.Top * 1000) / 1000;
        if (!lineGroups[y]) lineGroups[y] = [];
        lineGroups[y].push(line);
    });
    
    // Process each line group to extract items
    const items = [];
    let currentItem = null;
    
    Object.values(lineGroups).forEach(group => {
        // Skip header rows
        if (group.some(line => headers.some(h => line.Text === h.text))) return;
        
        // Sort lines left to right
        group.sort((a, b) => a.Geometry.BoundingBox.Left - b.Geometry.BoundingBox.Left);
        
        // Check if this is an item number line (e.g., "1.")
        const itemNoMatch = group[0]?.Text.match(/^(\d+)\.$/);
        
        if (itemNoMatch) {
            // If we have a current item, push it before starting a new one
            if (currentItem) {
                items.push(currentItem);
            }
            
            // Start a new item
            currentItem = {
                itemNo: itemNoMatch[1],
                quantity: '',
                quantityUnit: '',
                descriptions: [],
                unitPrice: '',
                amount: ''
            };
        } else if (currentItem) {
            // Process other lines for the current item
            const lineText = group[0]?.Text;
            
            // Check for quantity (e.g., "2,000 PCS")
            const quantityMatch = lineText.match(/^([\d,]+)\s+(PCS|PLS|EA|UNIT|UNITES|UNITS)$/i);
            if (quantityMatch) {
                currentItem.quantity = quantityMatch[1];
                currentItem.quantityUnit = quantityMatch[2].toLowerCase();
            }
            // Check for product code (e.g., "FG0244")
            else if (lineText.match(/^[A-Z]{2}\d+/)) {
                currentItem.descriptions.push(lineText);
            }
            // Check for description (e.g., "CODE CLIP 1")
            else if (lineText.match(/^CODE\s/)) {
                currentItem.descriptions.push(lineText);
            }
            // Check for LOT number
            else if (lineText.match(/^LOT\sNo/i)) {
                currentItem.descriptions.push(lineText);
            }
        }
    });
    
    // Push the last item if it exists
    if (currentItem) {
        items.push(currentItem);
    }
    
    // Clean up descriptions by joining them
    items.forEach(item => {
        if (item.descriptions.length > 0) {
            item.descriptions = item.descriptions.join(' ');
        } else {
            item.descriptions = '';
        }
    });
    
    return items;
}

function writeJsonToFile(data, filename) {
    const filePath = path.join(process.cwd(), filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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