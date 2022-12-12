import express from 'express'
import bodyParser from 'body-parser';

export const app = express();

app.post('/', bodyParser.json(), (req, res, next) => {
  const [event] = req.body;
  const signature = event.signature;
  const { mint } = event.tokenTransfers[0]

  console.log(mint, signature)

  next();
})