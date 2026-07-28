ALTER TABLE calibration_samples ADD COLUMN mean_scoring_loss REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN worst_scoring_loss REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN mean_conversion_loss REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN total_conversion_loss REAL NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN exact_best_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN slower_mate_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN total_mate_delay INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN missed_forced_mates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN settled_winning_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN settled_losing_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN non_best_winning_moves INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_samples ADD COLUMN conversion_moves INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_calibration_conversion
  ON calibration_samples (formula_version, slower_mate_moves, missed_forced_mates);
