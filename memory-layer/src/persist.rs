//! Append-only JSONL journal + snapshot/replay persistence.
use crate::model::Op;
use crate::store::StoreData;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

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

    /// Read every op ever written (oldest first).
    pub fn read_all(path: impl AsRef<Path>) -> std::io::Result<Vec<Op>> {
        let mut ops = Vec::new();
        if !path.as_ref().exists() {
            return Ok(ops);
        }
        for line in BufReader::new(File::open(path)?).lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            ops.push(serde_json::from_str(&line).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
            })?);
        }
        Ok(ops)
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
