const express = require('express');
const axios = require('axios');
const app = express();
const PORT = 3000;

app.get('/', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(400).send('❌ No Authorization header received.');
  }

  const encodedCreds = authHeader.split(' ')[1];
  const decoded = Buffer.from(encodedCreds, 'base64').toString('utf8');
  console.log('✅ Authorization header received and decoded:', decoded);

  try {
    const zendeskResponse = await axios.get(
      'https://intlxsolutions.zendesk.com/api/v2/users/me.json',
      {
        headers: {
          Authorization: `Basic ${encodedCreds}`,
        },
      }
    );

    const user = zendeskResponse.data.user;
    console.log('✔️ Zendesk Auth Success:', user.name);
    res.send(`✔️ Auth successful. Hello, ${user.name}`);
  } catch (error) {
    console.error('❌ Zendesk Auth Failed:', error.response?.data || error.message);
    res.status(401).send(`❌ Auth failed: ${error.response?.data?.error || error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Auth debugger server running on port ${PORT}`);
});
