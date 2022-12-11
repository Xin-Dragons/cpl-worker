import express from 'express'

export const app = express();

app.post('/webhook-event', (req, res, next) => {
  console.log(req.body);
  next();
})