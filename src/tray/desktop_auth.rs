use rand::RngCore;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DESKTOP_SESSION_TTL_SECS: i64 = 30 * 86400;

/// Issues a fresh 30-day desktop session token directly into 8046's SQLite `sessions` table
/// so the embedded WebView2 can skip the login screen without storing plaintext credentials.
pub fn ensure_desktop_session(db_path: &Path) -> Result<String, String> {
    if !db_path.exists() {
        return Err(format!("database not found: {}", db_path.display()));
    }

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = format!("desk_{}", hex::encode(bytes));
    let hash = hex::encode(Sha256::digest(token.as_bytes()));

    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {e}"))?
        .as_secs() as i64;
    let expires = now_unix + DESKTOP_SESSION_TTL_SECS;

    let db = Connection::open(db_path)
        .map_err(|e| format!("failed to open {}: {e}", db_path.display()))?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("failed to set busy_timeout: {e}"))?;

    let has_sessions: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to inspect schema: {e}"))?;
    if !has_sessions {
        return Err("sessions table does not exist yet".to_string());
    }

    db.execute("DELETE FROM sessions WHERE expires <= ?1", params![now_unix])
        .map_err(|e| format!("failed to prune expired sessions: {e}"))?;
    db.execute(
        "INSERT OR REPLACE INTO sessions (hash, expires) VALUES (?1, ?2)",
        params![hash, expires],
    )
    .map_err(|e| format!("failed to insert desktop session: {e}"))?;

    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_desktop_session_writes_sha256_hash_and_30d_expiry() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("gateway.db");
        let conn = Connection::open(&db_path).expect("open db");
        conn.execute(
            "CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
            [],
        )
        .expect("create sessions table");
        // Seed an expired session to verify pruning.
        conn.execute(
            "INSERT INTO sessions (hash, expires) VALUES ('stale', 100)",
            [],
        )
        .expect("insert stale");
        drop(conn);

        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let token = ensure_desktop_session(&db_path).expect("ensure_desktop_session");
        assert!(token.starts_with("desk_"));
        assert_eq!(token.len(), "desk_".len() + 64);

        let expected_hash = hex::encode(Sha256::digest(token.as_bytes()));
        let check_conn = Connection::open(&db_path).expect("reopen db");
        let count: i64 = check_conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1, "expired session should be pruned");

        let expires: i64 = check_conn
            .query_row(
                "SELECT expires FROM sessions WHERE hash = ?1",
                params![expected_hash],
                |row| row.get(0),
            )
            .expect("find inserted hash");
        assert!(expires > before + 29 * 86400);
    }

    #[test]
    fn ensure_desktop_session_errors_when_db_missing() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("missing.db");
        let err = ensure_desktop_session(&missing).unwrap_err();
        assert!(err.contains("database not found"));
    }
}
