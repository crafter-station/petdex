use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub fn write_runtime_token_at(dir: &Path, token: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join("update-token");
    fs::write(&path, token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(path)
}

pub fn write_runtime_token(token: &str) -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME or USERPROFILE not set"))?;
    write_runtime_token_at(&home.join(".petdex").join("runtime"), token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn write_runtime_token_at_creates_file_and_sets_permissions() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "petdex-runtime-token-test-{}-{nonce}",
            std::process::id()
        ));

        let path = write_runtime_token_at(&dir, "secret-token-123").expect("write runtime token");
        assert_eq!(path, dir.join("update-token"));
        assert_eq!(fs::read_to_string(&path).expect("read token"), "secret-token-123");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
