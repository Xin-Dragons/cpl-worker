import { app } from './server'

const PORT = process.env.port;

app.listen(PORT, () => {
  console.log(`app listing on port ${PORT}`)
});
