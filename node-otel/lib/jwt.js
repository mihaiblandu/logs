// Validates the HS256 tokens issued by the Laravel app (shared secret, issuer, audience).
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-shared-secret-change-me-0123456789abcdef';

/** @returns {{claims?: object, error?: string}} */
function verifyBearer(header) {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: 'missing token' };
  try {
    return { token, claims: jwt.verify(token, SECRET, { algorithms: ['HS256'], issuer: 'laravel-otel', audience: 'otel-demo', clockTolerance: 30 }) };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { verifyBearer };
