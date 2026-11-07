//! The bench harness's tools (ARCHITECTURE 3.8), run by `bench/harness.sh`:
//!
//! - `twigo-bench churn [--kubeconfig PATH] [--rate 100] [--seconds S] --log FILE` bumps
//!   restart counts of the `bench/bench` pods until S seconds pass or SIGINT, logs each change
//!   as a JSON line, and prints a summary. The kubeconfig defaults to `TWIGO_TEST_KUBECONFIG`.
//! - `twigo-bench launch <program> [args…]` becomes the program, responsible for itself, so
//!   that its WebKit processes are told apart from those of the terminal it was started from.
//! - `twigo-bench sample <pid>` prints the memory and CPU time of the app and of the WebKit
//!   processes it is responsible for (macOS).
//! - `twigo-bench report <dir>` prints the table of the seven metrics, writes `report.json`, and
//!   fails when a judged metric misses its target; none measured on the mock is judged.

mod churn;
mod process;
mod report;
mod stats;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str =
    "usage: twigo-bench churn [--kubeconfig PATH] [--rate N] [--seconds S] --log FILE
       twigo-bench launch <program> [args...]
       twigo-bench sample <pid>
       twigo-bench report <dir>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("churn") => churn(&args[1..]),
        Some("launch") => launch(&args[1..]),
        Some("sample") => sample(&args[1..]),
        Some("report") => report(&args[1..]),
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

#[cfg(target_os = "macos")]
fn sample(args: &[String]) -> Result<(), String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let [pid] = args else {
        return Err(USAGE.to_owned());
    };
    let pid: i32 = pid.parse().map_err(|_| USAGE)?;
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs_f64()
        * 1000.0;
    let sample = process::attribute(process::processes()?, pid, at_ms)?;
    println!(
        "{}",
        serde_json::to_string(&sample).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch(args: &[String]) -> Result<(), String> {
    let [program, args @ ..] = args else {
        return Err(USAGE.to_owned());
    };
    Err(process::launch(program, args))
}

#[cfg(not(target_os = "macos"))]
fn launch(_: &[String]) -> Result<(), String> {
    Err("launch exists for macOS's responsible processes only".to_owned())
}

#[cfg(not(target_os = "macos"))]
fn sample(_: &[String]) -> Result<(), String> {
    Err("the sampler reads macOS processes only".to_owned())
}

fn report(args: &[String]) -> Result<(), String> {
    let [dir] = args else {
        return Err(USAGE.to_owned());
    };
    let dir = Path::new(dir);
    let report = report::build(report::Inputs::read(dir)?);
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("report.json"), json).map_err(|e| e.to_string())?;
    print!("{}", report::table(&report));
    match report.failed().as_slice() {
        [] => Ok(()),
        failed => Err(format!("over their targets: {}", failed.join(", "))),
    }
}
