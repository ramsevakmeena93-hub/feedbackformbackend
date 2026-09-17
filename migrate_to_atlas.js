require('dotenv').config();
const mongoose = require('mongoose');

const LOCAL_URI = 'mongodb://localhost:27017/faculty_feedback';
const ATLAS_URI = process.env.MONGO_URI;

async function migrate() {
  console.log('\n=== MIGRATING LOCAL → ATLAS ===\n');
  console.log('Atlas URI:', ATLAS_URI.replace(/:([^:@]+)@/, ':****@'));

  const localConn = await mongoose.createConnection(LOCAL_URI).asPromise();
  console.log('✅ Local DB connected');

  const atlasConn = await mongoose.createConnection(ATLAS_URI).asPromise();
  console.log('✅ Atlas DB connected\n');

  const localDb = localConn.db;
  const atlasDb = atlasConn.db;

  const collections = await localDb.listCollections().toArray();
  console.log('Found collections:', collections.map(c => c.name).join(', '), '\n');

  let totalDocs = 0;

  for (const col of collections) {
    const name = col.name;
    if (name.startsWith('system.')) continue;

    const docs = await localDb.collection(name).find({}).toArray();
    if (docs.length === 0) {
      console.log(`  ⏭  SKIP  ${name}  (empty)`);
      continue;
    }

    // Clear existing Atlas data for this collection, then insert
    await atlasDb.collection(name).deleteMany({});
    const result = await atlasDb.collection(name).insertMany(docs);
    console.log(`  ✅  ${name.padEnd(25)} ${result.insertedCount} docs`);
    totalDocs += result.insertedCount;
  }

  console.log('\n=============================');
  console.log(`Total migrated: ${totalDocs} documents`);
  console.log('=============================\n');

  await localConn.close();
  await atlasConn.close();
  console.log('✅ Migration complete!\n');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
