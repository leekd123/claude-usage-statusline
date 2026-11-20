// What the widget shows, apart from Windows: widget.json as the mod writes it, the items a person can pick,
// and each item's label, value and widest value (its cell keeps that width, so the widget never resizes as
// the figures change).

use serde::Deserialize;

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub version: String,
    pub at: f64,
    pub limits: Vec<Limit>,
    pub cost_today: f64,
    pub tokens_today: f64,
    pub time_today: f64,
    pub stats: String,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Limit {
    pub kind: String,
    pub percent: f64,
    pub resets_at: Option<f64>,
}

// id, label, widest value
pub const ITEMS: [(&str, &str, &str); 7] = [
    ("limit5", "5h", "100%"),
    ("reset5", "5h reset", "6d 23:59:59"),
    ("limit7", "7d", "100%"),
    ("reset7", "7d reset", "6d 23:59:59"),
    ("cost", "Cost", "$9,999.99"),
    ("tokens", "Tokens", "999.99M"),
    ("time", "Agent", "9d 23:59:59"),
];

pub fn count(n: f64) -> String {
    if n >= 1e6 {
        format!("{:.2}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.1}k", n / 1e3)
    } else {
        format!("{}", n.max(0.0) as u64)
    }
}

pub fn cost(usd: f64) -> String {
    let cents = (usd.max(0.0) * 100.0).round() as u64;
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("${}.{:02}", grouped, cents % 100)
}

// Every time the widget shows: hh:mm:ss, with Nd before it from a day on.
pub fn clock(secs: u64) -> String {
    let (d, h, m, s) = (secs / 86_400, secs % 86_400 / 3600, secs % 3600 / 60, secs % 60);
    let hms = format!("{h:02}:{m:02}:{s:02}");
    if d > 0 {
        format!("{d}d {hms}")
    } else {
        hms
    }
}

// Time to a reset, rounded up, so it shows 00:00:00 only once the reset has come.
pub fn left(ms: f64) -> String {
    clock((ms / 1000.0).ceil().max(0.0) as u64)
}

pub fn elapsed(ms: f64) -> String {
    clock((ms / 1000.0).round().max(0.0) as u64)
}

// A usage item's share of its window, 0 to 100; none for other items or a window not reported.
// A window whose reset has passed is empty now; its next reset is not known until a response reports it.
pub fn usage(id: &str, data: &Data, now: f64) -> Option<f64> {
    let kind = match id {
        "limit5" => "five_hour",
        "limit7" => "seven_day",
        _ => return None,
    };
    let l = data.limits.iter().find(|l| l.kind == kind)?;
    Some(if l.resets_at.is_some_and(|r| r <= now) { 0.0 } else { l.percent.clamp(0.0, 100.0) })
}

pub fn value(id: &str, data: &Data, now: f64) -> String {
    let limit = |kind: &str| data.limits.iter().find(|l| l.kind == kind);
    let percent = |id: &str| usage(id, data, now).map_or("–".into(), |p| format!("{}%", p.round()));
    let reset = |kind: &str| match limit(kind).and_then(|l| l.resets_at) {
        Some(r) if r > now => left(r - now),
        _ => "–".into(),
    };
    match id {
        "limit5" | "limit7" => percent(id),
        "reset5" => reset("five_hour"),
        "reset7" => reset("seven_day"),
        "cost" => cost(data.cost_today),
        "tokens" => count(data.tokens_today),
        "time" => elapsed(data.time_today),
        _ => String::new(),
    }
}

// "0.1.10" > "0.1.9"
pub fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a) > parts(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figures() {
        assert_eq!(count(1_234_567.0), "1.23M");
        assert_eq!(count(50_000.0), "50.0k");
        assert_eq!(count(12.0), "12");
        assert_eq!(cost(1234.5), "$1,234.50");
        assert_eq!(cost(5.724), "$5.72");
        assert_eq!(left(((4 * 86_400 + 8 * 3600 + 13 * 60 + 5) * 1000) as f64), "4d 08:13:05");
        assert_eq!(left(194.0 * 60_000.0 + 0.4), "03:14:01"); // part of a second left counts as one
        assert_eq!(left(0.0), "00:00:00");
        assert_eq!(elapsed(45_000.0), "00:00:45");
        assert_eq!(elapsed(1_930_000.0), "00:32:10");
        assert_eq!(elapsed(25.0 * 3_600_000.0), "1d 01:00:00");
        assert!(newer("0.1.10", "0.1.9") && !newer("0.1.0", "0.1.0"));
    }

    #[test]
    fn limits_and_a_passed_reset() {
        let data: Data = serde_json::from_str(
            r#"{"version":"0.1.0","at":0,"limits":[{"kind":"five_hour","percent":4,"resetsAt":1000},{"kind":"seven_day","percent":10,"resetsAt":null}],"costToday":5.72,"tokensToday":50000,"timeToday":0,"stats":""}"#,
        )
        .unwrap();
        assert_eq!(value("limit5", &data, 0.0), "4%");
        assert_eq!(value("reset5", &data, 0.0), "00:00:01");
        assert_eq!(value("limit5", &data, 2000.0), "0%"); // the reset passed
        assert_eq!(value("reset5", &data, 2000.0), "–");
        assert_eq!(value("limit7", &data, 0.0), "10%");
        assert_eq!(value("reset7", &data, 0.0), "–");
        assert_eq!(usage("limit5", &data, 0.0), Some(4.0));
        assert_eq!(usage("limit5", &data, 2000.0), Some(0.0));
        assert_eq!(usage("reset5", &data, 0.0), None);
        assert_eq!(usage("limit7", &Data::default(), 0.0), None);
        assert_eq!(value("cost", &data, 0.0), "$5.72");
        assert_eq!(value("tokens", &data, 0.0), "50.0k");
        // A file cut off mid-write does not parse; the widget keeps what it had.
        assert!(serde_json::from_str::<Data>(r#"{"version":"0.1"#).is_err());
    }
}
