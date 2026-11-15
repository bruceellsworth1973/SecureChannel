use core::ptr;
use core::slice;
use core::str;

use securechannel_dialect::dialect::{Action, Dialect, Notice, Settlement};

pub const SC_ACTION_DROPPED: u32 = 3;
pub const SC_ACTION_FAILED: u32 = 5;
pub const SC_ACTION_SEND_BINARY: u32 = 2;
pub const SC_ACTION_SEND_TEXT: u32 = 1;
pub const SC_ACTION_SUCCEEDED: u32 = 4;
pub const SC_NOTICE_CONNECTING: u32 = 10;
pub const SC_NOTICE_EXCEPTION: u32 = 18;
pub const SC_NOTICE_IMPORT: u32 = 14;
pub const SC_NOTICE_LATENCY: u32 = 16;
pub const SC_NOTICE_NODES: u32 = 13;
pub const SC_NOTICE_OFFLINE: u32 = 12;
pub const SC_NOTICE_ONLINE: u32 = 11;
pub const SC_NOTICE_READY: u32 = 15;
pub const SC_NOTICE_STREAM_BYTES: u32 = 23;
pub const SC_NOTICE_STREAM_CLOSED: u32 = 22;
pub const SC_NOTICE_STREAM_DOWN: u32 = 21;
pub const SC_NOTICE_STREAM_UP: u32 = 20;
pub const SC_NOTICE_STREAMS: u32 = 19;
pub const SC_NOTICE_TYPED_DATA: u32 = 17;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ScAction {
    pub body: *const u8,
    pub body_length: usize,
    pub key: u64,
    pub kind: u32,
    pub name: *const u8,
    pub name_length: usize,
    pub seconds: f64,
}

#[derive(Debug, Default)]
pub struct ScDialect {
    current: Option<Action>,
    dialect: Dialect,
    imported: Vec<u8>,
}

impl ScAction {
    const fn empty(kind: u32) -> Self {
        Self { body: ptr::null(), body_length: 0, key: 0, kind, name: ptr::null(), name_length: 0, seconds: 0.0_f64 }
    }

    const fn with_body(mut self, body: &[u8]) -> Self {
        self.body = body.as_ptr();
        self.body_length = body.len();
        self
    }

    const fn with_name(mut self, name: &[u8]) -> Self {
        self.name = name.as_ptr();
        self.name_length = name.len();
        self
    }
}

impl ScDialect {
    fn describe(&mut self) -> Option<ScAction> {
        let action = self.current.as_ref()?;
        let described = match action {
            Action::SendText(text) => ScAction::empty(SC_ACTION_SEND_TEXT).with_body(text.as_bytes()),
            Action::SendBinary(frame) => ScAction::empty(SC_ACTION_SEND_BINARY).with_body(frame),
            Action::Dropped { reason } => ScAction::empty(SC_ACTION_DROPPED).with_body(reason.as_bytes()),
            Action::Settle { key, settlement } => {
                let (kind, body) = match settlement {
                    Settlement::Succeeded(result) => (SC_ACTION_SUCCEEDED, result),
                    Settlement::Failed(error) => (SC_ACTION_FAILED, error),
                };
                let mut settled = ScAction::empty(kind).with_body(body.as_bytes());
                settled.key = *key;
                settled
            }
            Action::Notify(notice) => match notice {
                Notice::Connecting => ScAction::empty(SC_NOTICE_CONNECTING),
                Notice::Offline => ScAction::empty(SC_NOTICE_OFFLINE),
                Notice::Ready => ScAction::empty(SC_NOTICE_READY),
                Notice::Online { session } => ScAction::empty(SC_NOTICE_ONLINE).with_name(session.as_bytes()),
                Notice::Nodes { nodes } => ScAction::empty(SC_NOTICE_NODES).with_body(nodes.as_bytes()),
                Notice::Exception { error } => ScAction::empty(SC_NOTICE_EXCEPTION).with_body(error.as_bytes()),
                Notice::Streams { streams } => ScAction::empty(SC_NOTICE_STREAMS).with_body(streams.as_bytes()),
                Notice::Latency { seconds } => {
                    let mut latency = ScAction::empty(SC_NOTICE_LATENCY);
                    latency.seconds = *seconds;
                    latency
                }
                Notice::Import { exports } => {
                    self.imported = exports.join("\n").into_bytes();
                    ScAction::empty(SC_NOTICE_IMPORT).with_body(&self.imported)
                }
                Notice::TypedData { kind, message } => {
                    ScAction::empty(SC_NOTICE_TYPED_DATA).with_name(kind.as_bytes()).with_body(message.as_bytes())
                }
                Notice::StreamBytes { payload, stream } => {
                    ScAction::empty(SC_NOTICE_STREAM_BYTES).with_name(stream.as_bytes()).with_body(payload)
                }
                Notice::StreamUp { stream } => ScAction::empty(SC_NOTICE_STREAM_UP).with_name(stream.as_bytes()),
                Notice::StreamDown { stream } => ScAction::empty(SC_NOTICE_STREAM_DOWN).with_name(stream.as_bytes()),
                Notice::StreamClosed { stream } => {
                    ScAction::empty(SC_NOTICE_STREAM_CLOSED).with_name(stream.as_bytes())
                }
            },
        };
        Some(described)
    }
}

unsafe fn bytes<'call>(start: *const u8, length: usize) -> &'call [u8] {
    if start.is_null() || length == 0 {
        return &[];
    }
    unsafe { slice::from_raw_parts(start, length) }
}

unsafe fn dialect<'call>(found: *mut ScDialect) -> Option<&'call mut ScDialect> {
    unsafe { found.as_mut() }
}

unsafe fn text<'call>(start: *const u8, length: usize) -> Result<&'call str, str::Utf8Error> {
    str::from_utf8(unsafe { bytes(start, length) })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_binary(found: *mut ScDialect, frame: *const u8, length: usize) {
    if let Some(session) = unsafe { dialect(found) } {
        session.dialect.binary(unsafe { bytes(frame, length) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_call(
    found: *mut ScDialect,
    command: *const u8,
    command_length: usize,
    arguments: *const u8,
    arguments_length: usize,
) -> u64 {
    let Some(session) = (unsafe { dialect(found) }) else {
        return 0;
    };
    let named = unsafe { text(command, command_length) };
    let given = unsafe { text(arguments, arguments_length) };
    match (named, given) {
        (Ok(name), Ok(json)) => session.dialect.call(name, json),
        (Err(error), _) | (_, Err(error)) => {
            session.dialect.dropped(format!("a call whose command or arguments are not UTF-8: {error}"));
            0
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_cancel(found: *mut ScDialect, key: u64) {
    if let Some(session) = unsafe { dialect(found) } {
        session.dialect.cancel(key);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_close_stream(found: *mut ScDialect, stream: *const u8, length: usize) {
    if let Some(session) = unsafe { dialect(found) } {
        match unsafe { text(stream, length) } {
            Ok(name) => session.dialect.close_stream(name),
            Err(error) => session.dialect.dropped(format!("a stream id that is not UTF-8: {error}")),
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_closed(found: *mut ScDialect) {
    if let Some(session) = unsafe { dialect(found) } {
        session.dialect.closed();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_expire(found: *mut ScDialect, key: u64, waited_milliseconds: u64) {
    if let Some(session) = unsafe { dialect(found) } {
        session.dialect.expire(key, waited_milliseconds);
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_free(found: *mut ScDialect) {
    if !found.is_null() {
        drop(unsafe { Box::from_raw(found) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_is_live(found: *mut ScDialect) -> bool {
    unsafe { dialect(found) }.is_some_and(|session| session.dialect.is_live())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_is_stream_up(found: *mut ScDialect, stream: *const u8, length: usize) -> bool {
    let Some(session) = (unsafe { dialect(found) }) else {
        return false;
    };
    unsafe { text(stream, length) }.is_ok_and(|name| session.dialect.is_stream_up(name))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_liveness_seconds(found: *mut ScDialect) -> u64 {
    unsafe { dialect(found) }.map_or(0, |session| session.dialect.liveness_seconds())
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_dialect_new() -> *mut ScDialect {
    Box::into_raw(Box::default())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_next_action(found: *mut ScDialect, action: *mut ScAction) -> bool {
    let Some(session) = (unsafe { dialect(found) }) else {
        return false;
    };
    let Some(slot) = (unsafe { action.as_mut() }) else {
        return false;
    };
    session.current = session.dialect.next_action();
    match session.describe() {
        Some(described) => {
            *slot = described;
            true
        }
        None => false,
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_open_stream(found: *mut ScDialect, stream: *const u8, length: usize) {
    if let Some(session) = unsafe { dialect(found) } {
        match unsafe { text(stream, length) } {
            Ok(name) => session.dialect.open_stream(name),
            Err(error) => session.dialect.dropped(format!("a stream id that is not UTF-8: {error}")),
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_opened(found: *mut ScDialect) {
    if let Some(session) = unsafe { dialect(found) } {
        session.dialect.opened();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_reconnect_delay_seconds(found: *mut ScDialect) -> u64 {
    unsafe { dialect(found) }.map_or(0, |session| session.dialect.reconnect_delay_seconds())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_rename_session(found: *mut ScDialect, session_id: *const u8, length: usize) {
    if let Some(session) = unsafe { dialect(found) } {
        match unsafe { text(session_id, length) } {
            Ok(name) => session.dialect.rename_session(name),
            Err(error) => session.dialect.dropped(format!("a session id that is not UTF-8: {error}")),
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_request_new_session(found: *mut ScDialect) {
    if let Some(session) = unsafe { dialect(found) } {
        session.dialect.request_new_session();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_text(found: *mut ScDialect, frame: *const u8, length: usize) {
    if let Some(session) = unsafe { dialect(found) } {
        match unsafe { text(frame, length) } {
            Ok(json) => session.dialect.text(json),
            Err(error) => session.dialect.dropped(format!("a text frame that is not UTF-8: {error}")),
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn sc_dialect_write_stream(
    found: *mut ScDialect,
    stream: *const u8,
    stream_length: usize,
    payload: *const u8,
    payload_length: usize,
) {
    if let Some(session) = unsafe { dialect(found) } {
        match unsafe { text(stream, stream_length) } {
            Ok(name) => session.dialect.write_stream(name, unsafe { bytes(payload, payload_length) }),
            Err(error) => session.dialect.dropped(format!("a stream id that is not UTF-8: {error}")),
        }
    }
}
