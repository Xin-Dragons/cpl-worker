import { run } from './workers/snapshot.worker';

(async () => {
  try {
    await run();
  } catch(e) {
    console.error(e);
    await run();
  }
})()
