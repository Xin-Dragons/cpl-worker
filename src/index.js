import path from 'path'
import { fork } from 'child_process';
import { chunk } from 'lodash';
import { getCollections } from './helpers';

async function run() {
  const collections = await getCollections();
  const chunks = chunk(collections, 10)

  chunks.map(ch => {
    fork(path.resolve(__dirname, './workers/worker.js'), ch.map(c => c.id), { cwd: process.cwd() })
  })
}
  
async function app() {
  try {
    await run();
  } catch(e) {
    console.error(e);
    await run();
  }
}

app();