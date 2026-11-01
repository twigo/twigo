//! Memory and CPU time of the app and of the WebKit processes that work for it.
//!
//! WKWebView runs its pages, networking and GPU work in `com.apple.WebKit.*` XPC services, which
//! launchd starts as its own children, so they are not the app's children and Safari's, Mail's
//! and other apps' run beside them. macOS records the process responsible for each one, the app
//! that asked for it, and the sampler reads it through
//! `responsibility_get_pid_responsible_for_pid`, an undocumented libsystem function.
//!
//! A process started from a terminal inherits the terminal as its responsible process, and so
//! do its WebKit processes, so `launch` starts the app responsible for itself, as launchd does,
//! through the equally undocumented `responsibility_spawnattrs_setdisclaim`.

use serde::{Deserialize, Serialize};

pub const WEBKIT_PREFIX: &str = "com.apple.WebKit.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: i32,
    pub responsible: i32,
    pub name: String,
    pub rss: u64,
    pub footprint: u64,
    pub cpu_ns: u64,
}

/// The app and the WebKit processes it is responsible for, with the other WebKit processes
/// that were left out.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at_ms: f64,
    pub app: Process,
    pub webkit: Vec<Process>,
    pub other_webkit: Vec<Process>,
}

pub fn attribute(processes: Vec<Process>, app: i32, at_ms: f64) -> Result<Sample, String> {
    let mut found = None;
    let (mut webkit, mut other_webkit) = (Vec::new(), Vec::new());
    for process in processes {
        if process.pid == app {
            found = Some(process);
        } else if process.name.starts_with(WEBKIT_PREFIX) {
            if process.responsible == app {
                webkit.push(process);
            } else {
                other_webkit.push(process);
            }
        }
    }
    let app = found.ok_or_else(|| format!("no process {app}"))?;
    if app.responsible != app.pid {
        return Err(format!(
            "{} ({}) is not responsible for itself but {}, so its WebKit processes cannot be told \
             apart: start it with `twigo-bench launch`",
            app.name, app.pid, app.responsible
        ));
    }
    Ok(Sample {
        at_ms,
        app,
        webkit,
        other_webkit,
    })
}

#[cfg(target_os = "macos")]
pub use macos::{launch, processes};

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString, c_char, c_int, c_void};
    use std::path::Path;

    use super::Process;

    type Responsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    type Disclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

    fn symbol(name: &CStr) -> Result<*mut c_void, String> {
        // SAFETY: dlsym only reads the NUL-terminated name.
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        if symbol.is_null() {
            return Err(format!("libsystem has no {}", name.to_string_lossy()));
        }
        Ok(symbol)
    }

    fn responsible() -> Result<Responsible, String> {
        let symbol = symbol(c"responsibility_get_pid_responsible_for_pid")?;
        // SAFETY: the symbol is libsystem's `pid_t responsibility_get_pid_responsible_for_pid(pid_t)`.
        Ok(unsafe { std::mem::transmute::<*mut c_void, Responsible>(symbol) })
    }

    /// Replaces this process with `program`, which becomes responsible for itself; returns only
    /// on failure.
    pub fn launch(program: &str, args: &[String]) -> String {
        let disclaim = match symbol(c"responsibility_spawnattrs_setdisclaim") {
            // SAFETY: the symbol is libsystem's
            // `int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *, int)`.
            Ok(symbol) => unsafe { std::mem::transmute::<*mut c_void, Disclaim>(symbol) },
            Err(error) => return error,
        };
        let argv: Result<Vec<CString>, _> = std::iter::once(program)
            .chain(args.iter().map(String::as_str))
            .map(CString::new)
            .collect();
        let Ok(argv) = argv else {
            return "an argument holds a NUL byte".to_owned();
        };
        let mut pointers: Vec<*mut c_char> =
            argv.iter().map(|arg| arg.as_ptr().cast_mut()).collect();
        pointers.push(std::ptr::null_mut());
        let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
        let mut pid = 0;
        // SAFETY: the attributes are initialised before use, argv is NULL-terminated and outlives
        // the call, and the environment is this process's own.
        let error = unsafe {
            libc::posix_spawnattr_init(&mut attributes);
            libc::posix_spawnattr_setflags(&mut attributes, libc::POSIX_SPAWN_SETEXEC as i16);
            disclaim(&mut attributes, 1);
            libc::posix_spawn(
                &mut pid,
                argv[0].as_ptr(),
                std::ptr::null(),
                &attributes,
                pointers.as_ptr(),
                *libc::_NSGetEnviron(),
            )
        };
        format!(
            "could not start {program}: {}",
            std::io::Error::from_raw_os_error(error)
        )
    }

    /// Converts the mach absolute time units of `rusage_info` CPU times to nanoseconds; they
    /// differ on Apple silicon.
    fn timebase() -> (u64, u64) {
        let mut info = mach2::mach_time::mach_timebase_info { numer: 0, denom: 0 };
        // SAFETY: the call fills the struct it is given.
        unsafe { mach2::mach_time::mach_timebase_info(&mut info) };
        (u64::from(info.numer), u64::from(info.denom))
    }

    fn pids() -> Result<Vec<i32>, String> {
        let mut pids = vec![0; 2048];
        loop {
            let bytes = c_int::try_from(pids.len() * size_of::<i32>()).expect("a small buffer");
            // SAFETY: the buffer holds `bytes` bytes.
            let count = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
            let count = usize::try_from(count)
                .map_err(|_| format!("proc_listallpids: {}", std::io::Error::last_os_error()))?;
            if count < pids.len() {
                pids.truncate(count);
                return Ok(pids);
            }
            pids.resize(pids.len() * 2, 0);
        }
    }

    fn name(pid: i32) -> Option<String> {
        let mut path = [0 as c_char; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer holds PROC_PIDPATHINFO_MAXSIZE bytes.
        let length = unsafe {
            libc::proc_pidpath(
                pid,
                path.as_mut_ptr().cast(),
                libc::PROC_PIDPATHINFO_MAXSIZE as u32,
            )
        };
        if length <= 0 {
            return None;
        }
        // SAFETY: proc_pidpath wrote a NUL-terminated path.
        let path = unsafe { CStr::from_ptr(path.as_ptr()) };
        Path::new(&*path.to_string_lossy())
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }

    fn usage(pid: i32) -> Option<libc::rusage_info_v4> {
        // SAFETY: rusage_info_v4 is plain integers, for which zero is valid.
        let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
        // SAFETY: RUSAGE_INFO_V4 fills a rusage_info_v4.
        let result = unsafe {
            libc::proc_pid_rusage(
                pid,
                libc::RUSAGE_INFO_V4,
                (&raw mut info).cast::<libc::rusage_info_t>(),
            )
        };
        (result == 0).then_some(info)
    }

    /// Every process this user may read; others' fail `proc_pid_rusage` and are skipped.
    pub fn processes() -> Result<Vec<Process>, String> {
        let responsible = responsible()?;
        let (numer, denom) = timebase();
        Ok(pids()?
            .into_iter()
            .filter(|&pid| pid > 0)
            .filter_map(|pid| {
                let info = usage(pid)?;
                Some(Process {
                    pid,
                    // SAFETY: the function takes and returns a pid.
                    responsible: unsafe { responsible(pid) },
                    name: name(pid)?,
                    rss: info.ri_resident_size,
                    footprint: info.ri_phys_footprint,
                    cpu_ns: (info.ri_user_time + info.ri_system_time) * numer / denom,
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: i32, responsible: i32, name: &str) -> Process {
        Process {
            pid,
            responsible,
            name: name.to_owned(),
            rss: 1,
            footprint: 1,
            cpu_ns: 1,
        }
    }

    #[test]
    fn only_the_apps_webkit_processes_count() {
        let all = vec![
            process(1, 1, "launchd"),
            process(500, 500, "Spotify"),
            process(501, 500, "com.apple.WebKit.Networking"),
            process(700, 700, "twigo"),
            process(701, 700, "com.apple.WebKit.WebContent"),
            process(702, 700, "com.apple.WebKit.Networking"),
            process(703, 700, "node"),
            process(801, 800, "com.apple.WebKit.GPU"),
        ];
        let sample = attribute(all, 700, 0.0).unwrap();
        assert_eq!(sample.app.name, "twigo");
        let pids = |list: &[Process]| list.iter().map(|p| p.pid).collect::<Vec<_>>();
        assert_eq!(pids(&sample.webkit), [701, 702]);
        assert_eq!(pids(&sample.other_webkit), [501, 801]);
    }

    #[test]
    fn no_sample_without_the_app() {
        assert!(attribute(vec![process(1, 1, "launchd")], 700, 0.0).is_err());
    }

    #[test]
    fn no_sample_of_an_app_another_process_is_responsible_for() {
        let all = vec![
            process(600, 600, "Terminal"),
            process(700, 600, "twigo"),
            process(701, 600, "com.apple.WebKit.WebContent"),
        ];
        let error = attribute(all, 700, 0.0).unwrap_err();
        assert!(error.contains("twigo-bench launch"), "{error}");
    }
}
