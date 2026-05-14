/**
 * Setup global dos testes: variáveis de ambiente mínimas para
 * que jwt.ts não lance erro no import (fail-fast exige JWT_SECRET).
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-tests-only-32chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-for-tests-only-32chars';
process.env.NODE_ENV = 'test';
