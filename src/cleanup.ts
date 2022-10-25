import { cleanup } from './helpers/db';

(async () => {
  console.log('Cleaning up orphans')
  await cleanup();
  console.log('Done')
})()