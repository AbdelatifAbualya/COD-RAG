import-to-mongodb.js
const { MongoClient } = require('mongodb');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Configuration
const MONGODB_URI = process.env.MONGODB_URI || 'your_connection_string_here';
const DB_NAME = 'kag-database';
const COLLECTION_NAME = 'examples';
const FILE_PATH = process.argv[2]; // Pass file path as command line argument

// Validate inputs
if (!FILE_PATH) {
  console.error('Please provide the path to your JSONL file as an argument');
  console.error('Example: node import-to-mongodb.js ./data/examples.jsonl');
  process.exit(1);
}

if (!fs.existsSync(FILE_PATH)) {
  console.error(`File not found: ${FILE_PATH}`);
  process.exit(1);
}

async function importData() {
  console.log(`Importing data from ${FILE_PATH} to MongoDB...`);
  console.log(`MongoDB URI: ${MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@')}`); // Hide credentials in logs
  
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    // Check if collection exists and has data
    const count = await collection.countDocuments();
    if (count > 0) {
      console.log(`Collection already contains ${count} documents`);
      const answer = await promptUser('Collection is not empty. Do you want to proceed and add more documents? (y/n): ');
      if (answer.toLowerCase() !== 'y') {
        console.log('Import cancelled');
        return;
      }
    }
    
    // Create text index for searching
    console.log('Creating text index on input and output fields...');
    await collection.createIndex({ 
      "input": "text", 
      "output": "text" 
    }, { 
      name: "search_index",
      weights: {
        input: 10,    // Input text is more important for matching
        output: 5     // Output text is still relevant but less so
      }
    });
    
    // Process the file
    const fileStream = fs.createReadStream(FILE_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let importedCount = 0;
    let errorCount = 0;
    let batch = [];
    const BATCH_SIZE = 1000; // Adjust based on your document size
    
    console.log('Starting import...');
    console.time('Import time');
    
    for await (const line of rl) {
      lineCount++;
      
      if (line.trim() === '') continue;
      
      try {
        const doc = JSON.parse(line);
        
        // Add metadata fields if needed
        doc.importedAt = new Date();
        
        batch.push(doc);
        
        // Process in batches for better performance
        if (batch.length >= BATCH_SIZE) {
          await collection.insertMany(batch);
          importedCount += batch.length;
          batch = [];
          
          // Progress log
          if (importedCount % 5000 === 0) {
            console.log(`Imported ${importedCount} documents so far...`);
          }
        }
      } catch (err) {
        errorCount++;
        console.error(`Error on line ${lineCount}: ${err.message}`);
        
        if (errorCount > 100) {
          console.error('Too many errors, aborting import');
          break;
        }
      }
    }

    // Insert remaining documents
    if (batch.length > 0) {
      await collection.insertMany(batch);
      importedCount += batch.length;
    }

    console.timeEnd('Import time');
    console.log(`Import completed:`);
    console.log(`- Total lines processed: ${lineCount}`);
    console.log(`- Documents imported: ${importedCount}`);
    console.log(`- Errors: ${errorCount}`);
    
    // Verify index creation
    const indexes = await collection.indexes();
    console.log('Collection indexes:');
    console.log(indexes);
    
  } catch (err) {
    console.error('Import failed:', err);
  } finally {
    await client.close();
    console.log('MongoDB connection closed');
  }
}

// Helper function to get user input
function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

// Run the import
importData().catch(console.error);
