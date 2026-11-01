//! The bench harness's tools (ARCHITECTURE 3.8):
//!
//! - `twigo-bench churn [--kubeconfig PATH] [--rate 100] [--seconds S] --log FILE` bumps
//!   restart counts of the `bench/bench` pods until S seconds pass or SIGINT, logs each change
//!   as a JSON line, and prints a summary. The kubeconfig defaults to `TWIGO_TEST_KUBECONFIG`.

mod churn;
mod stats;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str =
    "usage: twigo-bench churn [--kubeconfig PATH] [--rate N] [--seconds S] --log FILE";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("churn") => churn(&args[1..]),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn churn(args: &[String]) -> Result<(), String> {
    let (mut kubeconfig, mut rate, mut seconds, mut log) = (None, 100.0, None, None);
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or(USAGE)?;
        let number = || value.parse::<f64>().ok().filter(|n| *n > 0.0).ok_or(USAGE);
        match flag.as_str() {
            "--kubeconfig" => kubeconfig = Some(PathBuf::from(value)),
            "--rate" => rate = number()?,
            "--seconds" => seconds = Some(number()?),
            "--log" => log = Some(PathBuf::from(value)),
            _ => return Err(USAGE.to_owned()),
        }
    }
    let options = churn::Options {
        kubeconfig: churn::kubeconfig(kubeconfig.as_deref())?,
        rate,
        seconds,
        log: log.ok_or(USAGE)?,
    };
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let summary = runtime.block_on(churn::run(options))?;
    println!(
        "{}",
        serde_json::to_string(&summary).map_err(|e| e.to_string())?
    );
    Ok(())
}
