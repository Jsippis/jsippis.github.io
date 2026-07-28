ALTER TABLE calibration_samples ADD COLUMN phase_base_accuracy REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN competitive_mean_accuracy REAL;
ALTER TABLE calibration_samples ADD COLUMN winning_conversion_accuracy REAL;
ALTER TABLE calibration_samples ADD COLUMN losing_phase_accuracy REAL;
ALTER TABLE calibration_samples ADD COLUMN competitive_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN winning_phase_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN losing_phase_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN first_settled_ply INTEGER;
ALTER TABLE calibration_samples ADD COLUMN decisive_errors_before_settled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN mate_transitions_before_settled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN worst_pre_settled_scoring_loss REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN moves_after_first_decisive_error INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN immediate_mates_missed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN forced_mates_lost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN largest_mate_delay INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN missed_mate_severity_total REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN critical_error_penalty REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN mate_miss_penalty REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_calibration_phase
  ON calibration_samples (formula_version, rating_bucket, time_class, decisive_errors_before_settled);
