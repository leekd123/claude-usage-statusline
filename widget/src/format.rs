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
    ("reset5", "5h reset", "6d 23:59"),
    ("limit7", "7d", "100%"),
    ("reset7", "7d reset", "6d 23:59"),
    ("cost", "Cost", "$9,999.99"),
    ("tokens", "Tokens", "999.99M"),
    ("time", "Agent", "999:59"),
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

// Time to a reset, as the status line writes it: h:mm, or Nd h:mm.
pub fn left(ms: f64) -> String {
    let min = (ms / 60_000.0).round().max(0.0) as u64;
    let (d, h, m) = (min / 1440, (min % 1440) / 60, min % 60);
    if d > 0 {
        format!("{d}d {h}:{m:02}")
    } else {
        format!("{h}:{m:02}")
    }
}

pub fn hours(ms: f64) -> String {
    let min = (ms / 60_000.0).floor().max(0.0) as u64;
    format!("{}:{:02}", min / 60, min % 60)
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
        "time" => hours(data.time_today),
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
        assert_eq!(left(((4 * 1440 + 8 * 60 + 13) * 60_000) as f64), "4d 8:13");
        assert_eq!(left(194.0 * 60_000.0), "3:14");
        assert_eq!(hours(90.0 * 60_000.0), "1:30");
        assert!(newer("0.1.10", "0.1.9") && !newer("0.1.0", "0.1.0"));
    }

    #[test]
    fn limits_and_a_passed_reset() {
        let data: Data = serde_json::from_str(
            r#"{"version":"0.1.0","at":0,"limits":[{"kind":"five_hour","percent":4,"resetsAt":1000},{"kind":"seven_day","percent":10,"resetsAt":null}],"costToday":5.72,"tokensToday":50000,"timeToday":0,"stats":""}"#,
        )
        .unwrap();
        assert_eq!(value("limit5", &data, 0.0), "4%");
        assert_eq!(value("reset5", &data, 0.0), "0:00");
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
