pub const DATA_FRAME: u8 = 0x01;
pub const HEADER_LENGTH: usize = 6;
pub const SENTINEL: u8 = 0xFE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamFrame<'frame> {
    pub kind: u8,
    pub payload: &'frame [u8],
    pub uid: u32,
}

#[must_use]
pub fn build_data_frame(uid: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER_LENGTH.saturating_add(payload.len()));
    frame.push(SENTINEL);
    frame.push(DATA_FRAME);
    frame.extend_from_slice(&uid.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

#[must_use]
pub fn parse_frame(frame: &[u8]) -> Option<StreamFrame<'_>> {
    let (header, payload) = frame.split_at_checked(HEADER_LENGTH)?;
    let [sentinel, kind, first, second, third, fourth] = <[u8; HEADER_LENGTH]>::try_from(header).ok()?;
    (sentinel == SENTINEL).then_some(StreamFrame { kind, payload, uid: u32::from_be_bytes([first, second, third, fourth]) })
}
