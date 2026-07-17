// Test env: set BEFORE any src module is imported so config.ts and the
// Supabase client initialize with harmless values. No network calls are
// made — supabase-js only connects on use, and tests mock the db module.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_KEY = "test-service-key";
process.env.MODERATION_API_KEY = "test-moderation-key";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.REDIS_URL = ""; // no Redis in tests — verdict cache is a no-op
process.env.OPENAI_API_KEY = "sk-test-dummy";
process.env.DEEPSEEK_API_KEY = "sk-test-dummy";
