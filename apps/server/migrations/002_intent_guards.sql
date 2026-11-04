-- Authorization intents are looked up by strategy (one open authorization at a time).
CREATE INDEX IF NOT EXISTS intents_strategy ON intents (strategy_id, state) WHERE strategy_id IS NOT NULL;
