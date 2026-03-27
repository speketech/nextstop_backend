'use strict';

const jwt = require('jsonwebtoken');

/**
 * Middleware to authenticate JWT tokens
 */
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
      issuer: 'nextstop',
      audience: 'nextstop-app',
    });
    req.user = { id: decoded.sub, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

/**
 * Middleware to authorize based on user role
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }
    next();
  };
}

/**
 * Generate Access and Refresh tokens
 */
function generateTokens(payload) {
  const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: '1h',
    issuer: 'nextstop',
    audience: 'nextstop-app',
  });

  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: '7d',
    issuer: 'nextstop',
    audience: 'nextstop-app',
  });

  return { accessToken, refreshToken };
}

module.exports = {
  authenticate,
  authorize,
  generateTokens,
};
