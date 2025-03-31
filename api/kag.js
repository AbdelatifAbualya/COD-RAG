// api/kag.js
// Main API endpoint for Knowledge Augmented Generation (KAG)

const { MongoClient } = require('mongodb');
const { augmentPromptWithKagExamples, formatKagExamples } = require('./kag-search');

// MongoDB connection details
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'kag-database';
const collectionName = process.env.MONGODB_COLLECTION || 'examples';

// Cache MongoDB connection
let cachedDb = null;

async function connectToDatabase(uri) {
  if (cachedDb) {
    return cachedDb;
  }
  
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });
  
  await client.connect();
  const db = client.db(dbName);
  
  cachedDb = db;
  return db;
}

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
    console.log("KAG API called:", new Date().toISOString());
    
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

    // Get the query and optional parameters
    const query = requestBody.query;
    const collName = requestBody.collectionName || collectionName;
    const maxResults = parseInt(requestBody.maxResults || 3);
    const systemPrompt = requestBody.systemPrompt || "";
    
    console.log(`KAG query: "${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"`,
                `Collection: ${collName}, Max results: ${maxResults}`);
    
    // Connect to MongoDB
    const db = await connectToDatabase(uri);
    const collection = db.collection(collName);
    
    // Search for relevant examples
    // Using MongoDB's text search capability, which requires a text index
    // (db.examples.createIndex({ "input": "text", "output": "text" }))
    const examples = await collection.find(
      { $text: { $search: query } },
      { score: { $meta: "textScore" } }
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(maxResults)
    .toArray();
    
    console.log(`Found ${examples.length} matching examples`);

    // Format the response
    let responseData;
    
    if (systemPrompt) {
      // If system prompt is provided, augment it with examples
      responseData = {
        augmentedPrompt: augmentPromptWithKagExamples(systemPrompt, examples),
        examples: examples,
        count: examples.length
      };
    } else {
      // Just return the examples without augmenting a prompt
      responseData = {
        examples: examples,
        count: examples.length,
        formattedExamples: formatKagExamples(examples)
      };
    }

    // Send back the results
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).json(responseData);
    
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
