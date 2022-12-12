import express from 'express'
import bodyParser from 'body-parser';

export const app = express();

app.post('/', bodyParser.json(), (req, res, next) => {
  const [event] = req.body;
  const nft = event.events.nft;

  console.log(nft);
  console.log(event.signature)
  console.log(event.tokenTransfers[0])

  next();
})