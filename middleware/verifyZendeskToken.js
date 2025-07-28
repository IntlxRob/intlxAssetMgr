// middleware/verifyZendeskToken.js
module.exports = function verifyZendeskToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  const expectedToken = process.env.ZENDESK_API_TOKEN;

  if (token !== expectedToken) {
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }

  next(); // Token is valid, proceed to route
};
