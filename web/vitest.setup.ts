try {
  process.loadEnvFile(".env.test");
} catch {
  // No .env.test — env.ts reports the missing config clearly on its own.
}
