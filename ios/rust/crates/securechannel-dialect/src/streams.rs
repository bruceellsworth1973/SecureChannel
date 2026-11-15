use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub(crate) struct StreamIndex {
    advertised: HashMap<String, u32>,
    held: HashSet<String>,
    stream_by_uid: HashMap<u32, String>,
    uid_by_stream: HashMap<String, u32>,
}

#[derive(Debug, Default)]
pub(crate) struct Reconciliation {
    pub(crate) unwired: Vec<String>,
    pub(crate) wired: Vec<String>,
}

impl StreamIndex {
    pub(crate) fn close(&mut self, stream: &str) -> bool {
        let _ = self.unwire(stream);
        self.held.remove(stream)
    }

    pub(crate) fn held(&self) -> impl Iterator<Item = &String> {
        self.held.iter()
    }

    pub(crate) fn is_held(&self, stream: &str) -> bool {
        self.held.contains(stream)
    }

    pub(crate) fn is_wired(&self, stream: &str) -> bool {
        self.uid_by_stream.contains_key(stream)
    }

    pub(crate) fn open(&mut self, stream: &str) -> bool {
        if !self.held.insert(stream.to_owned()) {
            return false;
        }
        if let Some(uid) = self.advertised.get(stream).copied() {
            let _ = self.wire(stream, uid);
        }
        true
    }

    pub(crate) fn reconcile(&mut self, advertisement: HashMap<String, u32>) -> Reconciliation {
        let mut reconciliation = Reconciliation::default();
        self.advertised = advertisement;
        let subscribed: Vec<(String, u32)> = self
            .advertised
            .iter()
            .filter(|&(stream, _)| self.held.contains(stream))
            .map(|(stream, uid)| (stream.clone(), *uid))
            .collect();
        for (stream, uid) in subscribed {
            if self.wire(&stream, uid) {
                reconciliation.wired.push(stream);
            }
        }
        let lost: Vec<String> =
            self.uid_by_stream.keys().filter(|&stream| !self.advertised.contains_key(stream)).cloned().collect();
        for stream in lost {
            if self.unwire(&stream) {
                reconciliation.unwired.push(stream);
            }
        }
        reconciliation
    }

    pub(crate) fn stream_of(&self, uid: u32) -> Option<&String> {
        self.stream_by_uid.get(&uid)
    }

    pub(crate) fn uid_of(&self, stream: &str) -> Option<u32> {
        self.uid_by_stream.get(stream).copied()
    }

    pub(crate) fn unwire(&mut self, stream: &str) -> bool {
        self.uid_by_stream.remove(stream).is_some_and(|uid| {
            let _ = self.stream_by_uid.remove(&uid);
            true
        })
    }

    pub(crate) fn unwire_all(&mut self) -> Vec<String> {
        let wired: Vec<String> = self.uid_by_stream.keys().cloned().collect();
        wired.into_iter().filter(|stream| self.unwire(stream)).collect()
    }

    fn wire(&mut self, stream: &str, uid: u32) -> bool {
        let previous = self.uid_by_stream.insert(stream.to_owned(), uid);
        if previous == Some(uid) {
            return false;
        }
        if let Some(stale) = previous {
            let _ = self.stream_by_uid.remove(&stale);
        }
        let _ = self.stream_by_uid.insert(uid, stream.to_owned());
        previous.is_none()
    }
}
