export const prefixedSecretAssignments = [
  'DB_PASSWORD="fixture-only-value"',
  'AWS_SECRET_ACCESS_KEY="fixture-only-value"',
  '"DB_PASSWORD": "fixture-only-value"',
  "'AWS_SECRET_ACCESS_KEY': 'fixture-only-value'",
  "DB_PASSWORD = fixture-only-value",
  "AWS_SECRET_ACCESS_KEY: fixture-only-value",
  "dbPassword = 'fixture-only-value'",
  "service.api-key: fixture-only-value",
];

export const ordinaryReferenceCode = [
  'const dbPasswordLabel = "Password";',
  "const passwordPolicy = { minLength: 12 };",
  'const passwordHashAlgorithm = "argon2";',
  'const apiKeyName = "X-API-Key";',
  'const secretAccessKeyDescription = "Account setting";',
  "const tokenCount = 42;",
  "const enablePasswordLogin = true;",
  'DB_HOST = "localhost"',
  'AWS_REGION: "test-region"',
].join("\n");
