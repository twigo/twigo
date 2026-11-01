//! What each writing-system key of the active keyboard layout types, and
//! every change of that layout (ARCHITECTURE 5.2). WebKit has no Keyboard
//! Map API, so the keybinding service learns the layout from here.

mod keys;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
mod watch;
#[cfg(windows)]
mod win32;

use std::marker::PhantomData;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
use twigo_ipc::{ErrorKind, IpcError};
pub use twigo_ipc::{KeyMapping, KeyboardLayout};
pub use watch::{LayoutWatch, Subscription};
#[cfg(windows)]
use win32 as platform;

/// Proof that the caller runs on the UI thread, the only one where the OS's
/// layout APIs answer for the app: TIS is not thread safe and must run on
/// the main thread of a UI app, GDK only on the thread that initialised GTK,
/// and Windows keeps an input language per GUI thread.
#[derive(Clone, Copy)]
pub struct MainThread(PhantomData<*const ()>);

impl MainThread {
    /// None off the main thread on macOS, off GTK's thread on Linux, and on
    /// a thread without windows on Windows.
    pub fn new() -> Option<Self> {
        platform::is_main_thread().then_some(Self(PhantomData))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("the keyboard layout cannot be read: {0}")]
    Unavailable(String),
    #[error("no installed keyboard layout {0}")]
    NotFound(String),
}

impl From<&Error> for IpcError {
    fn from(error: &Error) -> Self {
        let kind = match error {
            Error::Unavailable(_) => ErrorKind::Unavailable,
            Error::NotFound(_) => ErrorKind::NotFound,
        };
        IpcError {
            kind,
            message: error.to_string(),
        }
    }
}
