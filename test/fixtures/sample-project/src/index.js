const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: true }));

// Intentional SQL injection for audit testing
app.get('/users', (req, res) => {
  const name = req.query.name;
  const query = `SELECT * FROM users WHERE name = '${name}'`;
  // db.query(query) would execute here
  res.send(query);
});

// Intentional XSS for audit testing
app.get('/greet', (req, res) => {
  const user = req.query.user;
  res.send(`<h1>Hello ${user}</h1>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
