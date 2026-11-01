//! logind's `PrepareForSleep(false)` for wake, which any process on the
//! system bus may receive (org.freedesktop.login1(5)), and rtnetlink's
//! address and route groups for the network, which need no privilege
//! (netlink(7)).

use futures::StreamExt;
use netlink_sys::{AsyncSocket, AsyncSocketExt, SocketAddr, TokioSocket, protocols::NETLINK_ROUTE};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

use crate::Event;

const GROUPS: u32 = (libc::RTMGRP_IPV4_IFADDR
    | libc::RTMGRP_IPV6_IFADDR
    | libc::RTMGRP_IPV4_ROUTE
    | libc::RTMGRP_IPV6_ROUTE) as u32;

pub struct Listeners {
    tasks: [JoinHandle<()>; 2],
}

impl Listeners {
    pub fn start(events: UnboundedSender<Event>) -> Self {
        let sleep = {
            let events = events.clone();
            tokio::spawn(async move {
                let woke = async {
                    let bus = zbus::Connection::system().await?;
                    wakes(&bus, &events).await
                };
                if let Err(error) = woke.await {
                    eprintln!(
                        "logind's sleep signal is out of reach, so a wake goes unseen: {error}"
                    );
                }
            })
        };
        let network = tokio::spawn(async move {
            if let Err(error) = changes(&events).await {
                eprintln!("rtnetlink is out of reach, so network changes go unseen: {error}");
            }
        });
        Self {
            tasks: [sleep, network],
        }
    }
}

impl Drop for Listeners {
    fn drop(&mut self) {
        self.tasks.iter().for_each(JoinHandle::abort);
    }
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Manager {
    #[zbus(signal)]
    fn prepare_for_sleep(&self, start: bool) -> zbus::Result<()>;
}

pub(crate) async fn wakes(
    bus: &zbus::Connection,
    events: &UnboundedSender<Event>,
) -> zbus::Result<()> {
    let mut signals = ManagerProxy::new(bus)
        .await?
        .receive_prepare_for_sleep()
        .await?;
    while let Some(signal) = signals.next().await {
        if !signal.args()?.start && events.send(Event::Woke).is_err() {
            break;
        }
    }
    Ok(())
}

async fn changes(events: &UnboundedSender<Event>) -> std::io::Result<()> {
    let mut socket = TokioSocket::new(NETLINK_ROUTE)?;
    socket.socket_mut().bind(&SocketAddr::new(0, GROUPS))?;
    loop {
        socket.recv_from_full().await?;
        if events.send(Event::NetworkChanged).is_err() {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use super::*;

    struct Login1;

    #[zbus::interface(name = "org.freedesktop.login1.Manager")]
    impl Login1 {
        #[zbus(signal)]
        async fn prepare_for_sleep(
            emitter: &zbus::object_server::SignalEmitter<'_>,
            start: bool,
        ) -> zbus::Result<()>;
    }

    struct Daemon(std::process::Child);

    impl Drop for Daemon {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A bus of the test's own with a login1 that sleeps and wakes.
    #[tokio::test]
    #[ignore = "needs dbus-daemon"]
    async fn a_resume_from_sleep_is_a_wake() {
        let mut daemon = Daemon(
            Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address"])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("dbus-daemon"),
        );
        let mut address = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(daemon.0.stdout.take().unwrap()),
            &mut address,
        )
        .unwrap();
        let address = address.trim();
        let login1 = zbus::connection::Builder::address(address)
            .unwrap()
            .name("org.freedesktop.login1")
            .unwrap()
            .serve_at("/org/freedesktop/login1", Login1)
            .unwrap()
            .build()
            .await
            .unwrap();
        let bus = zbus::connection::Builder::address(address)
            .unwrap()
            .build()
            .await
            .unwrap();
        let (events, mut received) = mpsc::unbounded_channel();
        tokio::spawn(async move { wakes(&bus, &events).await.unwrap() });
        tokio::time::sleep(Duration::from_millis(200)).await;

        let emitter =
            zbus::object_server::SignalEmitter::new(&login1, "/org/freedesktop/login1").unwrap();
        Login1::prepare_for_sleep(&emitter, true).await.unwrap();
        let asleep = tokio::time::timeout(Duration::from_millis(300), received.recv()).await;
        assert!(asleep.is_err(), "going to sleep is no wake");
        Login1::prepare_for_sleep(&emitter, false).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), received.recv()).await;
        assert_eq!(event.expect("a wake").unwrap(), Event::Woke);
    }

    /// Adds an address to a dummy link, which needs CAP_NET_ADMIN, as in
    /// `docker run --cap-add NET_ADMIN`.
    #[tokio::test]
    #[ignore = "needs CAP_NET_ADMIN"]
    async fn an_address_added_is_a_network_change() {
        let (events, mut received) = mpsc::unbounded_channel();
        tokio::spawn(async move { changes(&events).await.unwrap() });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let ip = |args: &[&str]| assert!(Command::new("ip").args(args).status().unwrap().success());
        ip(&["link", "add", "twigo0", "type", "dummy"]);
        ip(&["addr", "add", "10.99.0.1/24", "dev", "twigo0"]);
        let event = tokio::time::timeout(Duration::from_secs(5), received.recv()).await;
        ip(&["link", "del", "twigo0"]);
        assert_eq!(
            event.expect("a network change").unwrap(),
            Event::NetworkChanged
        );
    }
}
