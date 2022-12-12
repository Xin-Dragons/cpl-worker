import express from 'express'

export const app = express();

app.post('/', (req, res, next) => {
  console.log(req.body);
  next();
})