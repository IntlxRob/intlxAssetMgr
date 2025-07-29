require('dotenv').config(); // ✅ Loads environment variables from .env

const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Mount all API routes on /api
app.use('/api', apiRoutes);

// Root route for quick test
app.get('/', (req, res) => {
  res.send('Backend API is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
