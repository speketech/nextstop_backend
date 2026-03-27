'use strict';

const knex = require('knex');
const logger = require('./logger');

// Check if we are in production
const isProduction = process.env.NODE_ENV === 'production';

const db = knex({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Only enforce SSL if we are in the live production environment
    ssl: isProduction ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : false
  },
  pool: {
    min: Number(process.env.DB_POOL_MIN) || 2,
    max: Number(process.env.DB_POOL_MAX) || 10,
  },
});

db.raw('SELECT 1')
  .then(() => {
    logger.info(`[Database] Connected successfully [${process.env.NODE_ENV}]`);
  })
  .catch((err) => {
    logger.error('[Database] Connection failed', { error: err.message });
    process.exit(1);
  });

module.exports = db;