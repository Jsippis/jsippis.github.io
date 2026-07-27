CREATE TABLE IF NOT EXISTS calibration_samples (
  sample_id TEXT PRIMARY KEY,
  game_hash TEXT NOT NULL,
  player_color TEXT NOT NULL CHECK (player_color IN ('white', 'black')),
  rating_bucket INTEGER,
  time_class TEXT,
  move_count INTEGER NOT NULL,

  engine_version TEXT NOT NULL,
  analysis_profile TEXT NOT NULL,
  feature_version INTEGER NOT NULL,
  formula_version TEXT NOT NULL,

  mean_move_accuracy REAL NOT NULL,
  weighted_mean_accuracy REAL NOT NULL,
  geometric_mean_accuracy REAL NOT NULL,
  worst_quartile_accuracy REAL NOT NULL,
  mean_expected_loss REAL NOT NULL,
  total_expected_loss REAL NOT NULL,
  worst_expected_loss REAL NOT NULL,
  worst_three_expected_loss REAL NOT NULL,
  best_move_rate REAL NOT NULL,

  inaccuracies INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  blunders INTEGER NOT NULL,
  decisive_errors INTEGER NOT NULL,
  mate_transitions INTEGER NOT NULL,
  forced_moves INTEGER NOT NULL,
  settled_moves INTEGER NOT NULL,
  meaningful_moves INTEGER NOT NULL,

  chesscom_accuracy REAL NOT NULL,
  chesstein_accuracy REAL NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_calibration_formula
  ON calibration_samples (formula_version, analysis_profile);

CREATE INDEX IF NOT EXISTS idx_calibration_game
  ON calibration_samples (game_hash);

CREATE INDEX IF NOT EXISTS idx_calibration_time_class
  ON calibration_samples (time_class, rating_bucket);
