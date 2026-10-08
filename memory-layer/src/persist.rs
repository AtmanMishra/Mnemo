//! Append-only JSONL journal + snapshot/replay persistence.
//!
//! Tolerant load (ab99acb1): one corrupt/partial journal line must never
//! cause total amnesia. `read_all`/`read_all_reported` skip unparseable
//! lines, append them to `<journal>.corrupt` (one JSON record per damaged
//! line, with the reason), and keep replaying the rest. A crash mid-append
//! therefore costs at most the single torn line, not the whole history.
//! Recovery: the `.corrupt` file is a record for humans — if a line was
//! merely torn (no trailing newline), re-append the full op and delete it
//! from `.corrupt`; deliberately-mangled ops stay quarantined forever.
//! Journal growth is unbounded by design (append-only history); GC is
//! out of scope until a measured size threshold exists (see plan.md 12.15).
use crate::model::Op;
use crate::store::StoreData;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

/// Cap on how much of a damaged raw line is copied into the quarantine
/// record. A corrupt line can be arbitrarily large (a pasted blob); the
/// quarantine file must not grow unbounded from one incident.
const QUARANTINE_RAW_CAP: usize = 4096;

/// Result of a tolerant journal read: the ops that parsed, plus how many
/// lines were quarantined as unparseable.
#[derive(Debug, Default)]
pub struct LoadReport {
    pub ops: Vec<Op>,
    pub skipped: usize,
}

pub struct Journal {
    writer: BufWriter<File>,
    lock_path: std::path::PathBuf,
}

impl Journal {
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let f = OpenOptions::new().create(true).append(true).open(path)?;
        // advisory lock file next to the journal; every writer takes it before
        // appending so concurrent processes (memcli/memtui/memsrv/agents)
        // never interleave partial JSON lines.
        let mut lock_path = path.to_path_buf();
        lock_path.set_extension("lock");
        Ok(Self { writer: BufWriter::new(f), lock_path })
    }

    pub fn append(&mut self, op: &Op) -> std::io::Result<()> {
        let lock_file = OpenOptions::new().create(true).write(true)
            .open(&self.lock_path)?;
        let mut lock = fd_lock::RwLock::new(lock_file);
        let mut guard = lock.write()?;
        let _ = &mut *guard; // hold exclusive lock across the write
        serde_json::to_writer(&mut self.writer, op)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        drop(guard);
        Ok(())
    }

    /// Read every op ever written (oldest first). Corrupt lines are
    /// skipped and quarantined to `<journal>.corrupt` (see module docs);
    /// this errors only on genuine I/O failure.
    /// The lock file guarding this journal. A process that serves requests
    /// (memsrv) holds it exclusively for the whole request — read the tail
    /// other writers appended, then mutate, then append — so ids are always
    /// allocated from the true latest state. `append` alone only keeps lines
    /// whole; it cannot stop two stale stores handing out the same node id.
    pub fn lock_file(path: impl AsRef<Path>) -> std::io::Result<File> {
        let mut lock_path = path.as_ref().to_path_buf();
        lock_path.set_extension("lock");
        if let Some(dir) = lock_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        OpenOptions::new().read(true).write(true).create(true).open(lock_path)
    }

    /// Append while the CALLER holds the lock from `lock_file` (taking it
    /// again here would deadlock: flock is per open file description).
    pub fn append_held(&mut self, op: &Op) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.writer, op)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()
    }

    /// Ops appended after byte `offset`, and the offset just past the last
    /// complete line. The caller holds the lock. A journal shorter than
    /// `offset` was replaced underneath us; that is reported, not guessed at.
    pub fn read_from(path: impl AsRef<Path>, offset: u64) -> std::io::Result<(LoadReport, u64)> {
        let path = path.as_ref();
        let mut report = LoadReport::default();
        if !path.exists() {
            return Ok((report, 0));
        }
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < offset {
            return Err(std::io::Error::other(format!(
                "journal shrank from {offset} to {len} bytes while open; restart to reload it"
            )));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::new(file);
        let mut consumed = offset;
        loop {
            let mut raw: Vec<u8> = Vec::new();
            let read = reader.read_until(b'\n', &mut raw)?;
            if read == 0 || raw.last() != Some(&b'\n') { break; } // EOF or a partial line
            consumed += read as u64;
            parse_line(path, &raw, &mut report);
        }
        Ok((report, consumed))
    }

    pub fn read_all(path: impl AsRef<Path>) -> std::io::Result<Vec<Op>> {
        Ok(Self::read_all_reported(path)?.ops)
    }

    /// Tolerant read with a corruption report: how many lines were skipped
    /// (and quarantined) so callers can log — never silently — what was lost.
    ///
    /// dbfee81a: takes the SAME fd-lock `append` takes (shared/read side),
    /// so a reader can never observe a writer's in-flight partial line —
    /// without this, a reader racing an append could see the torn half of
    /// an op and quarantine a line the writer was about to complete.
    pub fn read_all_reported(path: impl AsRef<Path>) -> std::io::Result<LoadReport> {
        let path = path.as_ref();
        let mut report = LoadReport::default();
        if !path.exists() {
            return Ok(report);
        }
        // lock file protocol mirrors append(): <journal>.lock, shared side
        let mut lock_path = path.to_path_buf();
        lock_path.set_extension("lock");
        let lock_file = OpenOptions::new().read(true).write(true).create(true)
            .open(&lock_path)?;
        let lock = fd_lock::RwLock::new(lock_file);
        let _guard = lock.read()?; // held across the entire read
        let mut reader = BufReader::new(File::open(path)?);
        loop {
            let mut raw: Vec<u8> = Vec::new();
            let read = reader.read_until(b'\n', &mut raw)?;
            if read == 0 { break; } // clean EOF
            // a final line without '\n' (torn by a crash mid-append) is still
            // a candidate line — parse it; quarantine if it does not parse
            parse_line(path, &raw, &mut report);
        }
        Ok(report)
    }
}

/// One journal line into the report: an op, or a quarantined line.
fn parse_line(path: &Path, raw: &[u8], report: &mut LoadReport) {
    let line = match std::str::from_utf8(raw) {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            quarantine(path, "invalid utf-8", raw);
            report.skipped += 1;
            return;
        }
    };
    if line.is_empty() { return; } // blank padding is not corruption
    match serde_json::from_str::<Op>(&line) {
        Ok(op) => report.ops.push(op),
        Err(e) => {
            quarantine(path, &e.to_string(), raw);
            report.skipped += 1;
        }
    }
}

/// Best-effort append of one damaged line to `<journal>.corrupt`.
/// Never fatal: a quarantine failure must not turn into amnesia.
fn quarantine(path: &Path, reason: &str, raw: &[u8]) {
    let mut qpath = path.to_path_buf();
    qpath.set_extension("corrupt");
    let mut shown = String::from_utf8_lossy(raw).trim().to_string();
    if shown.len() > QUARANTINE_RAW_CAP {
        // cut at a char boundary — never split UTF-8 mid-sequence
        let cut = shown.char_indices().take_while(|(i, _)| *i <= QUARANTINE_RAW_CAP)
            .map(|(i, _)| i).last().unwrap_or(0);
        shown = format!("{}... [truncated {} bytes total]", &shown[..cut], raw.len());
    }
    let rec = serde_json::json!({ "reason": reason, "raw": shown });
    if let Some(dir) = qpath.parent() { let _ = std::fs::create_dir_all(dir); }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&qpath) {
        let _ = writeln!(f, "{rec}");
    }
}

/// Replay a full journal into a fresh store. Errors surface corrupt/misordered ops.
pub fn replay(ops: &[Op]) -> Result<StoreData, String> {
    let mut s = StoreData::new();
    for op in ops {
        s.apply(op)?;
    }
    Ok(s)
}

/// Write a compacted snapshot (the store itself, serialized).
pub fn write_snapshot(store: &StoreData, path: impl AsRef<Path>) -> std::io::Result<()> {
    if let Some(dir) = path.as_ref().parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.as_ref().with_extension("tmp");
    serde_json::to_writer(BufWriter::new(File::create(&tmp)?), store)?;
    std::fs::rename(tmp, path)
}

/// Load store from snapshot (if any), then replay journal tail.
/// Caller is responsible for knowing which journal suffix postdates the snapshot.
pub fn load(snapshot: Option<&Path>, ops: &[Op]) -> Result<StoreData, String> {
    match snapshot {
        Some(p) if p.exists() => {
            let raw = std::fs::read(p).map_err(|e| e.to_string())?;
            let mut s: StoreData = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            for op in ops {
                s.apply(op)?;
            }
            Ok(s)
        }
        _ => replay(ops),
    }
}
