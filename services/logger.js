// services/logger.js or adjust path as needed
const pino = require('pino');

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      translateTime: 'yyyy-mm-dd HH:MM:ss.l',
      colorize: true,
    },
  },
  level: 'debug',
});

module.exports = logger;
