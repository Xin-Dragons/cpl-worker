import { run } from './workers/cpl.worker';
import { app } from './server'
import { serialize } from '@metaplex-foundation/js';

(async () => {
  try {
    await run();
    app.listen(process.env.PORT, () => {

    });
  } catch(e) {
    console.error(e);
    await run();
  }
})()
