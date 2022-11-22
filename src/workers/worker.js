require("@babel/register");
const { updateCollection } = require('../app');

async function run(collections) {
  try {
    await collections.reduce((promise, collection) => {
      return promise.then(() => updateCollection(collection))
    }, Promise.resolve())
    return run(collections);

  } catch (err) {
    console.log(err)
    console.error('App crashed, restarting')
    return run(collections);
  }
}

(async () => {
  const [,,...collections] = process.argv;
  console.log(collections)
  
  await run(collections)
})()