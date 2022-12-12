import { app } from './server'

const PORT = process.env.PORT;

app.listen(PORT, () => {
  console.log(`app listing on port ${PORT}`)
});
