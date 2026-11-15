use std::collections::{HashMap, VecDeque};

use serde_json::{Map, Value, json};

use crate::frame::{DATA_FRAME, build_data_frame, parse_frame};
use crate::streams::StreamIndex;

const ABORTED: &str = "aborted";
const LONGEST_RECONNECT_SECONDS: u64 = 5;
const NOT_READY: &str = "socket not ready";

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Dropped { reason: String },
    Notify(Notice),
    SendBinary(Vec<u8>),
    SendText(String),
    Settle { key: u64, settlement: Settlement },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Notice {
    Connecting,
    Exception { error: String },
    Import { exports: Vec<String> },
    Latency { seconds: f64 },
    Nodes { nodes: String },
    Offline,
    Online { session: String },
    Ready,
    StreamBytes { payload: Vec<u8>, stream: String },
    StreamClosed { stream: String },
    StreamDown { stream: String },
    StreamUp { stream: String },
    Streams { streams: String },
    TypedData { kind: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Settlement {
    Failed(String),
    Succeeded(String),
}

#[derive(Debug, Default)]
pub struct Dialect {
    actions: VecDeque<Action>,
    calls: HashMap<u64, String>,
    checked_in: bool,
    exports_known: bool,
    failures: u64,
    keepalive_seconds: u64,
    last_key: u64,
    live: bool,
    session: Option<String>,
    streams: StreamIndex,
}

impl Dialect {
    pub fn binary(&mut self, frame: &[u8]) {
        let Some(parsed) = parse_frame(frame) else {
            self.dropped(format!("a binary frame of {} bytes without the stream header", frame.len()));
            return;
        };
        if parsed.kind != DATA_FRAME {
            self.dropped(format!("stream frame type {} for uid {}", parsed.kind, parsed.uid));
            return;
        }
        let Some(stream) = self.streams.stream_of(parsed.uid).cloned() else {
            self.dropped(format!("a data frame for uid {}, which is wired to no open stream", parsed.uid));
            return;
        };
        self.notify(Notice::StreamBytes { payload: parsed.payload.to_vec(), stream });
    }

    pub fn call(&mut self, command: &str, arguments: &str) -> u64 {
        self.last_key = self.last_key.saturating_add(1);
        let key = self.last_key;
        if !self.live {
            self.settle(key, Settlement::Failed(json!(NOT_READY).to_string()));
            return key;
        }
        let mut request = Map::new();
        let _ = request.insert(String::from("command"), json!(command));
        match serde_json::from_str::<Value>(arguments) {
            Ok(Value::Object(named)) => request.extend(named),
            Ok(Value::Null) => {}
            Ok(other) => {
                let refusal = format!("{command} takes one object of named arguments, not {other}");
                self.settle(key, Settlement::Failed(json!(refusal).to_string()));
                return key;
            }
            Err(error) => {
                let refusal = format!("the arguments for {command} are not JSON: {error}");
                self.settle(key, Settlement::Failed(json!(refusal).to_string()));
                return key;
            }
        }
        let _ = self.calls.insert(key, command.to_owned());
        self.send("request", &json!({ "key": key, "request": request }));
        key
    }

    pub fn cancel(&mut self, key: u64) {
        if self.calls.remove(&key).is_some() {
            self.settle(key, Settlement::Failed(json!(ABORTED).to_string()));
        }
    }

    pub fn close_stream(&mut self, stream: &str) {
        if !self.streams.is_held(stream) {
            return;
        }
        if self.live {
            self.send("streamUnsubscribe", &json!({ "streamId": stream }));
        }
        let _ = self.streams.close(stream);
        self.notify(Notice::StreamClosed { stream: stream.to_owned() });
    }

    pub fn closed(&mut self) {
        self.failures = self.failures.saturating_add(1);
        self.checked_in = false;
        let keys: Vec<u64> = self.calls.drain().map(|(key, _)| key).collect();
        for key in keys {
            self.settle(key, Settlement::Failed(json!(ABORTED).to_string()));
        }
        for stream in self.streams.unwire_all() {
            self.notify(Notice::StreamDown { stream });
        }
        if self.live {
            self.live = false;
            self.notify(Notice::Offline);
        }
    }

    pub fn expire(&mut self, key: u64, waited_milliseconds: u64) {
        if let Some(command) = self.calls.remove(&key) {
            let reason = format!("request timed out: {command} after {waited_milliseconds}ms");
            self.settle(key, Settlement::Failed(json!(reason).to_string()));
        }
    }

    #[must_use]
    pub const fn is_live(&self) -> bool {
        self.live
    }

    #[must_use]
    pub fn is_stream_up(&self, stream: &str) -> bool {
        self.streams.is_wired(stream)
    }

    #[must_use]
    pub const fn liveness_seconds(&self) -> u64 {
        self.keepalive_seconds.saturating_mul(2)
    }

    pub fn next_action(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    pub fn open_stream(&mut self, stream: &str) {
        if self.streams.open(stream) && self.live {
            self.send("streamSubscribe", &json!({ "streamId": stream }));
        }
    }

    pub fn opened(&mut self) {
        self.notify(Notice::Connecting);
    }

    #[must_use]
    pub fn reconnect_delay_seconds(&self) -> u64 {
        self.failures.saturating_sub(1).min(LONGEST_RECONNECT_SECONDS)
    }

    pub fn rename_session(&mut self, session: &str) {
        self.session = Some(session.to_owned());
        self.send("sessionid", &json!({ "SessionID": session }));
    }

    pub fn request_new_session(&mut self) {
        self.send("newsession", &json!({}));
    }

    #[must_use]
    pub fn session(&self) -> Option<&str> {
        self.session.as_deref()
    }

    pub fn text(&mut self, frame: &str) {
        let envelope = match serde_json::from_str::<Value>(frame) {
            Ok(Value::Object(envelope)) => envelope,
            Ok(other) => {
                self.dropped(format!("a text frame that is not an envelope object: {other}"));
                return;
            }
            Err(error) => {
                self.dropped(format!("a text frame that is not JSON ({error}): {frame}"));
                return;
            }
        };
        let (Some(Value::String(kind)), Some(Value::Object(message))) = (envelope.get("type"), envelope.get("message"))
        else {
            self.dropped(format!("an envelope without a string type and an object message: {frame}"));
            return;
        };
        self.route(kind, message);
    }

    pub fn write_stream(&mut self, stream: &str, payload: &[u8]) {
        match self.streams.uid_of(stream) {
            Some(uid) => self.actions.push_back(Action::SendBinary(build_data_frame(uid, payload))),
            None => self.dropped(format!("{} bytes written to stream {stream} while it is down", payload.len())),
        }
    }

    fn checkin(&mut self, message: &Map<String, Value>) {
        if self.checked_in {
            return;
        }
        let nodes = message.get("nodes").map_or_else(|| String::from("null"), Value::to_string);
        self.notify(Notice::Nodes { nodes });
        if self.exports_known {
            self.checked_in = true;
            self.send("checkin", &json!({}));
        } else {
            self.send("exports", &json!({}));
        }
    }

    pub fn dropped(&mut self, reason: String) {
        self.actions.push_back(Action::Dropped { reason });
    }

    fn import(&mut self, message: &Map<String, Value>) {
        let exports: Vec<String> = message
            .get("exports")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        self.exports_known = true;
        self.notify(Notice::Import { exports });
        self.send("checkin", &json!({}));
        self.checked_in = true;
    }

    fn notify(&mut self, notice: Notice) {
        self.actions.push_back(Action::Notify(notice));
    }

    fn ready(&mut self) {
        let held: Vec<String> = self.streams.held().cloned().collect();
        for stream in held {
            self.send("streamSubscribe", &json!({ "streamId": stream }));
        }
        self.notify(Notice::Ready);
    }

    fn respond(&mut self, message: &Map<String, Value>) {
        let Some(key) = message.get("key").and_then(Value::as_u64) else {
            self.dropped(format!("a response without a call key: {}", Value::Object(message.clone())));
            return;
        };
        if self.calls.remove(&key).is_none() {
            return;
        }
        let outcome = message.get("result").and_then(Value::as_object);
        let error = outcome.and_then(|found| found.get("error")).filter(|&found| is_truthy(found));
        let settlement = error.map_or_else(
            || {
                Settlement::Succeeded(
                    outcome.and_then(|found| found.get("result")).map_or_else(|| String::from("null"), Value::to_string),
                )
            },
            |failure| Settlement::Failed(failure.to_string()),
        );
        self.settle(key, settlement);
    }

    fn route(&mut self, kind: &str, message: &Map<String, Value>) {
        match kind {
            "up" => self.up(message),
            "checkin" => self.checkin(message),
            "import" => self.import(message),
            "ready" => self.ready(),
            "response" => self.respond(message),
            "streams" => self.streams_advertised(message),
            "latency" => {
                if let Some(seconds) = message.get("latency").and_then(Value::as_f64) {
                    self.notify(Notice::Latency { seconds });
                }
            }
            "data" => self.typed_data(message),
            "error" => {
                let error = message.get("error").map_or_else(|| String::from("null"), Value::to_string);
                self.notify(Notice::Exception { error });
            }
            _ => {}
        }
    }

    fn send(&mut self, kind: &str, message: &Value) {
        self.actions.push_back(Action::SendText(json!({ "type": kind, "message": message }).to_string()));
    }

    fn settle(&mut self, key: u64, settlement: Settlement) {
        self.actions.push_back(Action::Settle { key, settlement });
    }

    fn streams_advertised(&mut self, message: &Map<String, Value>) {
        let listed = message.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
        let advertisement: HashMap<String, u32> = listed
            .iter()
            .filter_map(|entry| {
                let stream = entry.get("streamId")?.as_str()?;
                let uid = u32::try_from(entry.get("uid")?.as_u64()?).ok()?;
                Some((stream.to_owned(), uid))
            })
            .collect();
        let reconciliation = self.streams.reconcile(advertisement);
        for stream in reconciliation.wired {
            if self.live {
                self.send("streamSubscribe", &json!({ "streamId": stream }));
            }
            self.notify(Notice::StreamUp { stream });
        }
        for stream in reconciliation.unwired {
            self.notify(Notice::StreamDown { stream });
        }
        self.notify(Notice::Streams { streams: Value::Array(listed).to_string() });
    }

    fn typed_data(&mut self, message: &Map<String, Value>) {
        let Some(kind) = message.get("type").and_then(Value::as_str) else {
            return;
        };
        let carried = message.get("message").map_or_else(|| String::from("null"), Value::to_string);
        self.notify(Notice::TypedData { kind: kind.to_owned(), message: carried });
    }

    fn up(&mut self, message: &Map<String, Value>) {
        let session = message.get("SessionID").and_then(Value::as_str).unwrap_or_default().to_owned();
        self.keepalive_seconds = message.get("keepalive").and_then(Value::as_u64).unwrap_or_default();
        self.session = Some(session.clone());
        self.live = true;
        self.failures = 0;
        self.notify(Notice::Online { session });
    }
}

fn is_truthy(found: &Value) -> bool {
    match found {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|amount| amount != 0.0_f64 && !amount.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
