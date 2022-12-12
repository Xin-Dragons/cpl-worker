import { run } from './workers/cpl.worker';

(async () => {
  try {
    await run();
  } catch(e) {
    console.error(e);
    await run();
  }
})()
