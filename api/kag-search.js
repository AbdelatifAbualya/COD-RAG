// api/kag-search.js
// This module searches the dataset for relevant examples based on the query

const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;

module.exports = async (req, res) => {
  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // Log function invocation to help with debugging
    console.log("KAG Search API called:", new Date().toISOString());
    
    // Check if MongoDB URI is configured
    if (!uri) {
      console.error("ERROR: MongoDB URI is missing in environment variables");
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(500).json({ 
        error: 'Configuration error', 
        message: 'Database connection string not configured'
      });
      return;
    }

    // Parse request body
    let requestBody;
    try {
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ 
        error: 'Invalid JSON in request body', 
        message: parseError.message 
      });
      return;
    }

    // Validate the query parameter
    if (!requestBody.query) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ error: 'Missing required parameter: query' });
      return;
    }

    // Get query and extract keywords
    const query = requestBody.query;
    const maxResults = requestBody.maxResults || 3; // Default to 3 examples
    
    console.log(`KAG search query: "${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"`);
    
    // Connect to MongoDB
    const client = new MongoClient(uri);
    await client.connect();
    
    // Search for relevant examples
    const db = client.db('kag-database');
    const collection = db.collection('examples');
    
    // Create a text search query
    // MongoDB text search will automatically tokenize and find relevant documents
    // You should create a text index on your collection with:
    // db.examples.createIndex({ "input": "text", "output": "text" })
    const examples = await collection.find(
      { $text: { $search: query } },
      { score: { $meta: "textScore" } }
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(maxResults)
    .toArray();
    
    // Close MongoDB connection
    await client.close();
    
    console.log(`Found ${examples.length} matching examples`);

    // Send back the results
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(examples);
    
  } catch (error) {
    console.error('Function error:', error.message, error.stack);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: error.message
    });
  }
};

// utilities/kag-processor.js
// This utility helps format the KAG examples for insertion into prompts

/**
 * Formats KAG examples for inclusion in the prompt
 * @param {Array} examples - Array of example objects from database
 * @return {String} Formatted examples for inclusion in prompt
 */
function formatKagExamples(examples) {
  if (!examples || examples.length === 0) {
    return "";
  }

  let formatted = "\n\n## RELEVANT EXAMPLES:\n\n";
  
  examples.forEach((example, index) => {
    formatted += `EXAMPLE ${index + 1}:\n`;
    formatted += `User: ${example.input}\n`;
    formatted += `Assistant: ${example.output}\n\n`;
  });
  
  formatted += "## END OF EXAMPLES\n\n";
  
  return formatted;
}

/**
 * Inserts formatted KAG examples into the system prompt
 * @param {String} systemPrompt - The original system prompt
 * @param {Array} examples - KAG examples to insert
 * @return {String} Updated system prompt with examples
 */
function augmentPromptWithKagExamples(systemPrompt, examples) {
  if (!examples || examples.length === 0) {
    return systemPrompt;
  }
  
  const formattedExamples = formatKagExamples(examples);
  
  // Insert examples after the first paragraph of the system prompt
  // This is a heuristic that works well for many system prompts
  const firstParagraphEnd = systemPrompt.indexOf("\n\n");
  
  if (firstParagraphEnd !== -1) {
    return systemPrompt.substring(0, firstParagraphEnd + 2) + 
           formattedExamples + 
           systemPrompt.substring(firstParagraphEnd + 2);
  } else {
    // If no paragraph break, just append to the end
    return systemPrompt + "\n\n" + formattedExamples;
  }
}

module.exports = {
  formatKagExamples,
  augmentPromptWithKagExamples
};

// data-import/import-to-mongodb.js
// Run this script once to import your JSONL data to MongoDB

const { MongoClient } = require('mongodb');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const FILE_PATH = process.argv[2] || './data/examples.jsonl';

async function importData() {
  if (!MONGODB_URI) {
    console.error('MONGODB_URI environment variable is required');
    process.exit(1);
  }

  if (!fs.existsSync(FILE_PATH)) {
    console.error(`File not found: ${FILE_PATH}`);
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db('kag-database');
    const collection = db.collection('examples');
    
    // Create text index for efficient search
    await collection.createIndex({ "input": "text", "output": "text" });
    console.log('Created text index on input and output fields');

    // Read the JSONL file line by line
    const fileStream = fs.createReadStream(FILE_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let count = 0;
    const batchSize = 1000;
    let batch = [];

    console.log('Starting import...');
    
    for await (const line of rl) {
      try {
        if (line.trim()) {
          const doc = JSON.parse(line);
          batch.push(doc);
          count++;
          
          if (batch.length >= batchSize) {
            await collection.insertMany(batch);
            console.log(`Imported ${count} documents...`);
            batch = [];
          }
        }
      } catch (err) {
        console.error('Error parsing line:', err);
      }
    }

    // Insert any remaining documents
    if (batch.length > 0) {
      await collection.insertMany(batch);
    }

    console.log(`Import completed. Total documents imported: ${count}`);
    
  } catch (err) {
    console.error('Error during import:', err);
  } finally {
    await client.close();
    console.log('MongoDB connection closed');
  }
}

importData().catch(console.error);
