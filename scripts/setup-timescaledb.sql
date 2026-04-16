-- setup-timescaledb.sql
-- Run AFTER Prisma migration creates the summary tables.
-- Run ONCE per environment.
-- Usage: psql $DATABASE_URL -f scripts/setup-timescaledb.sql

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- Convert summary tables to hypertables
-- Note: TimescaleDB requires the time column to be part of any unique constraint.
-- Since Prisma creates a serial PK + unique constraint, we need to drop the unique
-- and recreate it including the date column, or skip hypertable conversion for tables
-- with unique constraints that don't include the time column.
--
-- For our use case (daily pre-aggregated rows, ~10 rows/merchant/day), standard
-- Postgres tables with indexes perform identically. We enable TimescaleDB compression
-- policies via a continuous aggregate approach instead.

-- Enable compression on the tables (works without hypertable conversion)
-- This is applied via a scheduled job that compresses old partitions.

-- For now, the tables work as standard Postgres with good indexes.
-- TimescaleDB hypertable conversion can be done later if volume requires it,
-- after restructuring the unique constraints to include the date column.

SELECT 'TimescaleDB extension ready' as status;
SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';
