use chrono::Local;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};

pub const DEFAULT_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MB
pub const DEFAULT_MAX_ROTATIONS: usize = 3; // .1 ~ .3

#[derive(Debug)]
struct RollingWriter {
    base_path: PathBuf,
    max_bytes: u64,
    max_rotations: usize,
    current_size: u64,
    file: Option<File>,
}

impl RollingWriter {
    fn new(base_path: PathBuf, max_bytes: u64, max_rotations: usize) -> Result<Self, String> {
        if let Some(parent) = base_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create log directory {}: {e}", parent.display()))?;
        }
        let current_size = fs::metadata(&base_path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&base_path)
            .map_err(|e| format!("Failed to open log file {}: {e}", base_path.display()))?;
        Ok(Self {
            base_path,
            max_bytes,
            max_rotations,
            current_size,
            file: Some(file),
        })
    }

    fn rotated_path(&self, index: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", self.base_path.display(), index))
    }

    fn rotate(&mut self) -> Result<(), String> {
        self.file.take();

        if self.max_rotations > 0 {
            let oldest = self.rotated_path(self.max_rotations);
            if oldest.exists() {
                let _ = fs::remove_file(&oldest);
            }
            for idx in (1..self.max_rotations).rev() {
                let src = self.rotated_path(idx);
                let dst = self.rotated_path(idx + 1);
                if src.exists() {
                    let _ = fs::rename(&src, &dst);
                }
            }
            if self.base_path.exists() {
                let first = self.rotated_path(1);
                fs::rename(&self.base_path, &first).map_err(|e| {
                    format!(
                        "Failed to rotate {} -> {}: {e}",
                        self.base_path.display(),
                        first.display()
                    )
                })?;
            }
        }

        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.base_path)
            .map_err(|e| format!("Failed to reopen log file {}: {e}", self.base_path.display()))?;
        self.file = Some(file);
        self.current_size = 0;
        Ok(())
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        if self.current_size + bytes.len() as u64 > self.max_bytes && self.current_size > 0 {
            self.rotate()?;
        }
        if let Some(file) = self.file.as_mut() {
            file.write_all(bytes)
                .map_err(|e| format!("Failed to write log {}: {e}", self.base_path.display()))?;
            let _ = file.flush();
            self.current_size += bytes.len() as u64;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct RollingFileLogger {
    inner: Arc<Mutex<RollingWriter>>,
}

impl RollingFileLogger {
    pub fn open(base_path: impl AsRef<Path>) -> Result<Self, String> {
        Self::open_with_limits(
            base_path.as_ref().to_path_buf(),
            DEFAULT_MAX_LOG_BYTES,
            DEFAULT_MAX_ROTATIONS,
        )
    }

    pub fn open_with_limits(
        base_path: PathBuf,
        max_bytes: u64,
        max_rotations: usize,
    ) -> Result<Self, String> {
        let writer = RollingWriter::new(base_path, max_bytes, max_rotations)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(writer)),
        })
    }

    pub fn log_line(&self, level: &str, msg: &str) {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let formatted = format!("[{ts}] [{level}] {msg}\n");
        if let Ok(mut guard) = self.inner.lock() {
            let _ = guard.write_bytes(formatted.as_bytes());
        }
    }

    pub fn info(&self, msg: &str) {
        self.log_line("INFO", msg);
    }

    pub fn warn(&self, msg: &str) {
        self.log_line("WARN", msg);
    }

    pub fn error(&self, msg: &str) {
        self.log_line("ERROR", msg);
    }

    pub fn write_stream_line(&self, stream: &str, line: &str) {
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let formatted = format!("[{ts}] [{stream}] {trimmed}\n");
        if let Ok(mut guard) = self.inner.lock() {
            let _ = guard.write_bytes(formatted.as_bytes());
        }
    }
}

fn drain_stream_lines<R: std::io::Read>(reader: R, stream: &str, logger: &RollingFileLogger) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                logger.write_stream_line(stream, &line);
            }
        }
    }
}

pub fn pipe_child_output(child: &mut Child, logger: RollingFileLogger) {
    if let Some(stdout) = child.stdout.take() {
        let log = logger.clone();
        std::thread::Builder::new()
            .name("tray-log-stdout".into())
            .spawn(move || drain_stream_lines(stdout, "stdout", &log))
            .ok();
    }

    if let Some(stderr) = child.stderr.take() {
        let log = logger;
        std::thread::Builder::new()
            .name("tray-log-stderr".into())
            .spawn(move || drain_stream_lines(stderr, "stderr", &log))
            .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_logger_rotates_up_to_three_backups() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("tray.log");
        let logger = RollingFileLogger::open_with_limits(log_path.clone(), 40, 3).unwrap();

        for i in 0..10 {
            logger.info(&format!("line-{i:02}-abcdefghijklmno"));
        }

        assert!(log_path.exists());
        assert!(dir.path().join("tray.log.1").exists());
        assert!(dir.path().join("tray.log.2").exists());
        assert!(dir.path().join("tray.log.3").exists());
        assert!(!dir.path().join("tray.log.4").exists());

        let active_len = fs::metadata(&log_path).unwrap().len();
        assert!(active_len <= 64);
    }

    #[test]
    fn drain_stream_lines_continues_through_gbk_and_invalid_utf8_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("child.log");
        let logger = RollingFileLogger::open(&log_path).unwrap();

        // Mix valid UTF-8 lines with GBK ("中文") and invalid UTF-8 bytes
        let input: Vec<u8> = b"first-utf8-line\n\xd6\xd0\xce\xc4-gbk-line\n\xff\xfe-raw-bytes\nfinal-line-after-invalid\n".to_vec();
        drain_stream_lines(std::io::Cursor::new(input), "stdout", &logger);

        let content = fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("first-utf8-line"));
        assert!(lines[1].contains("-gbk-line"));
        assert!(lines[2].contains("-raw-bytes"));
        assert!(lines[3].contains("final-line-after-invalid"));
    }
}
