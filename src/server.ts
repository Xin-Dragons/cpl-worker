import express from 'express'
import bodyParser from 'body-parser';
import { recordSale } from './helpers'
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export const app = express();

app.post('/', bodyParser.json(), async (req, res, next) => {
  const [event] = req.body;
  
  const { amount, buyer, seller, nfts, signature } = event.events.nft;
  console.log('received event', signature)
  const price = amount / LAMPORTS_PER_SOL;

  await nfts.map((item: any) => recordSale({ mint: item.mint, signature, price, buyer, seller }));

  next();
})