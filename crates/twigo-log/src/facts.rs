/// What a run of Twigo is: the first line of each run's log, and what a
/// problem report states.
///
/// None of it names a person, a machine or a cluster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// Twigo's version, the workspace's.
    pub version: String,
    /// The commit the build came from; `local build` when the build was not
    /// given one.
    pub commit: String,
    /// The operating system's name, as `os_info` names it: `Mac OS`,
    /// `Ubuntu`, `Windows`.
    pub os: String,
    /// The operating system's version: `27.2.1`; `Unknown` where `os_info`
    /// cannot tell.
    pub os_version: String,
    /// The processor architecture the app was built for: `aarch64`, `x86_64`.
    pub arch: &'static str,
    /// The web engine the platform gives the window: `WebKit` on macOS,
    /// `WebKitGTK` on Linux, `WebView2` on Windows.
    pub engine: &'static str,
    /// The engine's version as Tauri reads it, none where it cannot.
    pub engine_version: Option<String>,
}

impl Facts {
    /// The facts of this run. `commit` is what `option_env!("TWIGO_COMMIT")`
    /// gave the app's build, and `engine_version` what
    /// `tauri::webview_version()` answered.
    pub fn detect(version: &str, commit: Option<&str>, engine_version: Option<String>) -> Self {
        let os = os_info::get();
        Self {
            version: version.to_owned(),
            commit: commit.unwrap_or("local build").to_owned(),
            os: os.os_type().to_string(),
            os_version: os.version().to_string(),
            arch: std::env::consts::ARCH,
            engine: if cfg!(target_os = "macos") {
                "WebKit"
            } else if cfg!(windows) {
                "WebView2"
            } else {
                "WebKitGTK"
            },
            engine_version,
        }
    }

    pub(crate) fn log(&self, filter: &str) {
        tracing::info!(
            version = %self.version,
            commit = %self.commit,
            os = %self.os,
            os_version = %self.os_version,
            arch = self.arch,
            engine = self.engine,
            engine_version = self.engine_version.as_deref(),
            filter,
            "Twigo started"
        );
    }
}
