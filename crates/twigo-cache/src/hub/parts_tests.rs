use std::time::Duration;

use tokio::time::sleep;
use twigo_ipc::ViewState;

use super::tests::{budget, query, ready, until};
use crate::fake::Fake;

fn forbidden() -> ViewState {
    ViewState::Forbidden {
        verb: "watch".to_owned(),
        resource: "pods".to_owned(),
    }
}

#[tokio::test(start_paused = true)]
async fn a_refused_part_says_so_while_its_retry_waits_for_a_watch() {
    let fake = Fake::default();
    fake.state()
        .forbidden
        .insert("/api/v1/namespaces/a/pods".to_owned());
    let (hub, _clients) = fake.hub(budget(1));
    let mut a = hub.rows(query(&["a"])).await.unwrap();
    until(&mut a, |state| *state == forbidden()).await;
    let mut b = hub.rows(query(&["b"])).await.unwrap();
    ready(&mut b).await;

    sleep(Duration::from_secs(30)).await;
    assert_eq!(a.state(), forbidden(), "its retries wait behind b's watch");
}
