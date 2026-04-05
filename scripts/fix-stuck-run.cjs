require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING);
  await client.connect();
  const db = client.db();

  // Find all collections that might have runs
  const collections = await db.listCollections().toArray();
  const runCollNames = collections.filter(c => c.name.includes('runs')).map(c => c.name);
  console.log('Run collections:', runCollNames);

  for (const collName of runCollNames) {
    const coll = db.collection(collName);
    const stuckRuns = await coll.find({ status: 'running' }).toArray();
    if (stuckRuns.length > 0) {
      console.log(`\nFound ${stuckRuns.length} stuck runs in ${collName}:`);
      for (const run of stuckRuns) {
        console.log(`  run_id: ${run.run_id} | title: ${run.title} | started: ${run.started_at}`);
        // Mark as cancelled
        await coll.updateOne(
          { run_id: run.run_id },
          { $set: { status: 'cancelled', completed_at: new Date().toISOString(), error: 'Manually cancelled - stuck in running state' } }
        );
        console.log(`  -> Updated to cancelled`);
      }
    }
  }

  // Also fix any stuck step records
  const stepCollNames = collections.filter(c => c.name.includes('step')).map(c => c.name);
  for (const collName of stepCollNames) {
    const coll = db.collection(collName);
    const stuckSteps = await coll.find({ status: 'running' }).toArray();
    if (stuckSteps.length > 0) {
      console.log(`\nFound ${stuckSteps.length} stuck steps in ${collName}:`);
      for (const step of stuckSteps) {
        console.log(`  step_id: ${step.step_id} | name: ${step.name} | run_id: ${step.run_id}`);
        await coll.updateOne(
          { execution_id: step.execution_id },
          { $set: { status: 'cancelled', completed_at: new Date().toISOString(), summary: 'Cancelled - stuck in running state' } }
        );
        console.log(`  -> Updated to cancelled`);
      }
    }
  }

  await client.close();
  console.log('\nDone.');
}

main().catch(e => console.log('Error:', e.message));
