import express from 'express'
import bodyParser from 'body-parser';

export const app = express();

app.post('/', bodyParser.json(), (req, res, next) => {
  console.log(req.body);
  next();
})